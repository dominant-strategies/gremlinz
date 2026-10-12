// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SyndicateVault
 * @notice Backers pool QUAI into a gremlin; the gremlin runs with it and shares what it earns. One contract serves
 * two models:
 *
 *  - Syndicate (open-ended): anyone can contribute at any time. Shares are priced at the vault's current value per
 *    share, so later backers don't dilute earlier ones.
 *  - Quest syndicate (`fundingTarget > 0`): backers fund one goal. Contributions are 1:1 until the target is met by
 *    the funding deadline (otherwise everyone is refunded in full). When the gremlin completes the quest, or the
 *    quest deadline passes, the syndicate dissolves and what is left is returned to backers.
 *
 * What the contract guarantees (and what it can't):
 *  - Backers' capital sits here. The gremlin can draw at most `drawBps` of it per 30-day epoch, so unspent
 *    capital is protected. Nobody else can move it, and there is no admin.
 *  - Income sent here is split exactly: maker cut, the gremlin's operating share, the rest to backers by shares.
 *    Whether the gremlin routes its income here is up to the gremlin; the board tracks it, the contract can't.
 *  - The gremlin earns a management fee: `mgmtFeeBps` per year of the capital held here, streamed.
 *  - Backers holding `dissolveBps` of shares can dissolve the vault, and anyone can dissolve it if the gremlin
 *    stops checking in for `inactivityPeriod`. Dissolving never stops the gremlin; it only returns the remaining
 *    capital to backers.
 *
 * Shares are not transferable. Native QUAI only. Payments are pull-based.
 */
contract SyndicateVault is ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant EPOCH = 30 days;
    uint256 public constant YEAR = 365 days;
    /// A gremlin's report of value held outside the vault counts towards share pricing for this long.
    uint256 public constant REPORT_TTL = 30 days;
    uint256 private constant MAG = 2 ** 96;
    /// Keeps share counts large enough that per-share dividend accounting never overflows or rounds to nothing.
    uint256 public constant MIN_CONTRIBUTION = 0.01 ether;

    struct Params {
        address gremlin;
        address maker; // may be zero (no maker cut)
        uint16 makerBps; // of income, to the maker
        uint16 incomeKeepBps; // of income, kept by the gremlin to operate
        uint16 mgmtFeeBps; // per year, of capital held here
        uint16 drawBps; // max share of capital the gremlin may draw per epoch
        uint16 dissolveBps; // share of all shares whose votes dissolve the vault
        uint32 inactivityPeriod; // seconds without a gremlin check-in before anyone may dissolve
        // quest syndicate (all zero for an open-ended syndicate)
        bytes32 goalHash; // keccak256 of the goal text as written in the gremlin's config
        uint256 fundingTarget;
        uint64 fundingDeadline;
        uint64 questDeadline;
    }

    address public immutable gremlin;
    address public immutable maker;
    uint16 public immutable makerBps;
    uint16 public immutable incomeKeepBps;
    uint16 public immutable mgmtFeeBps;
    uint16 public immutable drawBps;
    uint16 public immutable dissolveBps;
    uint32 public immutable inactivityPeriod;
    bytes32 public immutable goalHash;
    uint256 public immutable fundingTarget;
    uint64 public immutable fundingDeadline;
    uint64 public immutable questDeadline;

    // shares
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public contributed;
    uint256 public totalContributed;

    // capital and fees
    uint256 public capital;
    uint256 public lastAccrual;
    uint256 public epochIndex;
    uint256 public epochStartCapital;
    uint256 public drawnThisEpoch;
    uint256 public totalDrawn;

    // value the gremlin reports holding outside the vault (counts towards pricing while fresh)
    uint256 public reportedOutside;
    uint256 public reportedAt;
    uint256 public lastCheckIn;

    // pull balances
    uint256 public owedGremlin;
    uint256 public owedMaker;

    // dividends (magnified per-share accounting)
    uint256 private magnifiedPerShare;
    mapping(address => int256) private corrections;
    mapping(address => uint256) public withdrawnDividends;
    uint256 public dividendLiability; // assigned to backers, not yet withdrawn
    uint256 private dust; // rounding remainder carried into the next distribution

    // lifecycle
    bool public funded; // always true for open-ended syndicates
    bool public dissolved;
    bool public questCompleted;
    mapping(address => bool) public votedDissolve;
    uint256 public dissolveVotes;

    event Contributed(address indexed backer, uint256 amount, uint256 sharesMinted, uint256 navBefore);
    event Funded(uint256 raised);
    event Income(address indexed from, uint256 amount, uint256 toMaker, uint256 toGremlin, uint256 toBackers);
    event DividendPaid(address indexed from, uint256 amount);
    event Drawn(uint256 amount, uint256 capitalLeft);
    event FeeAccrued(uint256 amount);
    event ValueReported(uint256 outside, uint256 nav);
    event CheckIn();
    event Vote(address indexed backer, bool dissolve, uint256 weight);
    event QuestCompleted(string evidence);
    event Dissolved(string reason, uint256 capitalReturned);
    event Withdrawn(address indexed to, uint256 amount);

    error InvalidParams();
    error NotGremlin();
    error NotMaker();
    error Closed();
    error NotFunded();
    error FundingClosed();
    error OverTarget();
    error PriceUnknown();
    error OverAllowance();
    error NotDissolvable();
    error NothingOwed();
    error TransferFailed();
    error ZeroAmount();

    modifier onlyGremlin() {
        if (msg.sender != gremlin) revert NotGremlin();
        _;
    }

    constructor(Params memory p) {
        if (p.gremlin == address(0)) revert InvalidParams();
        if (uint256(p.makerBps) + p.incomeKeepBps > BPS) revert InvalidParams();
        if (p.makerBps > 0 && p.maker == address(0)) revert InvalidParams();
        if (p.mgmtFeeBps > 1_000) revert InvalidParams(); // at most 10% a year
        if (p.drawBps == 0 || p.drawBps > BPS) revert InvalidParams();
        if (p.dissolveBps < 5_000 || p.dissolveBps > BPS) revert InvalidParams();
        if (p.inactivityPeriod < 7 days) revert InvalidParams();
        if (p.fundingTarget > 0) {
            if (p.fundingDeadline <= block.timestamp || p.questDeadline <= p.fundingDeadline) revert InvalidParams();
        } else if (p.fundingDeadline != 0 || p.questDeadline != 0 || p.goalHash != bytes32(0)) {
            revert InvalidParams();
        }
        gremlin = p.gremlin;
        maker = p.maker;
        makerBps = p.makerBps;
        incomeKeepBps = p.incomeKeepBps;
        mgmtFeeBps = p.mgmtFeeBps;
        drawBps = p.drawBps;
        dissolveBps = p.dissolveBps;
        inactivityPeriod = p.inactivityPeriod;
        goalHash = p.goalHash;
        fundingTarget = p.fundingTarget;
        fundingDeadline = p.fundingDeadline;
        questDeadline = p.questDeadline;
        funded = p.fundingTarget == 0;
        lastAccrual = block.timestamp;
        lastCheckIn = block.timestamp;
    }

    function isQuest() public view returns (bool) {
        return fundingTarget > 0;
    }

    // ------------------------------------------------------------------------------------------------------
    // Backers
    // ------------------------------------------------------------------------------------------------------

    /// @notice Value used to price new shares: capital held here plus a fresh report of value held outside.
    function nav() public view returns (uint256) {
        uint256 outside = block.timestamp <= reportedAt + REPORT_TTL ? reportedOutside : 0;
        return capital - _pendingFee() + outside;
    }

    /// @notice Become a backer. Quest syndicates take contributions 1:1 until the target is reached.
    function contribute() external payable nonReentrant {
        if (dissolved) revert Closed();
        if (msg.value < MIN_CONTRIBUTION) revert ZeroAmount();
        _accrue();
        uint256 navBefore = nav();
        uint256 minted;
        if (isQuest()) {
            if (funded || block.timestamp > fundingDeadline) revert FundingClosed();
            if (totalContributed + msg.value > fundingTarget) revert OverTarget();
            minted = msg.value;
        } else if (totalShares == 0) {
            minted = msg.value;
        } else {
            if (navBefore == 0) revert PriceUnknown(); // all capital drawn and no fresh report: ask the gremlin
            minted = (msg.value * totalShares) / navBefore;
            if (minted == 0) revert ZeroAmount();
        }
        _mint(msg.sender, minted);
        contributed[msg.sender] += msg.value;
        totalContributed += msg.value;
        _rollEpoch();
        capital += msg.value;
        epochStartCapital += msg.value; // new capital raises this epoch's allowance too
        emit Contributed(msg.sender, msg.value, minted, navBefore);
        if (isQuest() && totalContributed == fundingTarget) {
            funded = true;
            lastAccrual = block.timestamp; // fees start once the quest is funded
            lastCheckIn = block.timestamp;
            emit Funded(totalContributed);
        }
    }

    /// @notice Vote to dissolve (or withdraw your vote). Weight is your shares, kept current as you contribute.
    function voteDissolve(bool support) external {
        if (dissolved) revert Closed();
        uint256 w = shares[msg.sender];
        if (w == 0) revert ZeroAmount();
        if (support == votedDissolve[msg.sender]) return;
        votedDissolve[msg.sender] = support;
        if (support) dissolveVotes += w;
        else dissolveVotes -= w;
        emit Vote(msg.sender, support, w);
    }

    function dividendsOf(address a) public view returns (uint256) {
        int256 total = int256(magnifiedPerShare * shares[a]) + corrections[a];
        return uint256(total) / MAG - withdrawnDividends[a];
    }

    /// @notice Withdraw your share of income, dividends and returned capital.
    function withdraw() external nonReentrant {
        uint256 amount = dividendsOf(msg.sender);
        if (amount == 0) revert NothingOwed();
        withdrawnDividends[msg.sender] += amount;
        dividendLiability -= amount;
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------------------------------------------

    /// @notice Income: split into the maker's cut, the gremlin's operating share and backers' dividends.
    receive() external payable {
        _income(msg.sender, msg.value);
    }

    /// @notice Pay backers directly (all of it goes to backers, no cuts), e.g. a promised profit share.
    function payDividend() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit DividendPaid(msg.sender, msg.value);
        _distribute(msg.value);
    }

    /// @notice Treats QUAI that arrived without running receive() (forced sends) as income.
    function sync() external {
        uint256 accounted = capital + owedGremlin + owedMaker + dividendLiability + dust;
        uint256 bal = address(this).balance;
        if (bal > accounted) _income(address(0), bal - accounted);
    }

    // ------------------------------------------------------------------------------------------------------
    // The gremlin
    // ------------------------------------------------------------------------------------------------------

    /// @notice What the gremlin may still draw this epoch.
    function drawable() public view returns (uint256) {
        if (dissolved || !funded) return 0;
        uint256 cap = capital - _pendingFee();
        uint256 epoch = block.timestamp / EPOCH;
        uint256 base = epoch == epochIndex ? epochStartCapital : cap;
        uint256 used = epoch == epochIndex ? drawnThisEpoch : 0;
        uint256 limit = (base * drawBps) / BPS;
        uint256 left = limit > used ? limit - used : 0;
        return left < cap ? left : cap;
    }

    /// @notice Draw capital to run the gremlin's business, within this epoch's allowance.
    function draw(uint256 amount) external onlyGremlin nonReentrant {
        if (dissolved) revert Closed();
        if (!funded) revert NotFunded();
        _accrue();
        _rollEpoch();
        if (amount == 0) revert ZeroAmount();
        if (amount > drawable()) revert OverAllowance();
        drawnThisEpoch += amount;
        totalDrawn += amount;
        capital -= amount;
        lastCheckIn = block.timestamp;
        emit Drawn(amount, capital);
        _send(gremlin, amount);
    }

    /// @notice Report value held outside the vault (counts towards share pricing for REPORT_TTL). Also a check-in.
    function reportValue(uint256 outside) external onlyGremlin {
        _accrue();
        reportedOutside = outside;
        reportedAt = block.timestamp;
        lastCheckIn = block.timestamp;
        emit ValueReported(outside, nav());
    }

    function checkIn() external onlyGremlin {
        lastCheckIn = block.timestamp;
        emit CheckIn();
    }

    /// @notice Quest syndicates: the gremlin declares the goal reached; the syndicate dissolves and returns what's left.
    function completeQuest(string calldata evidence) external onlyGremlin {
        if (!isQuest() || !funded) revert NotFunded();
        if (dissolved) revert Closed();
        questCompleted = true;
        emit QuestCompleted(evidence);
        _dissolve("quest completed");
    }

    function withdrawGremlin() external nonReentrant {
        _accrue();
        uint256 a = owedGremlin;
        if (a == 0) revert NothingOwed();
        owedGremlin = 0;
        _send(gremlin, a);
    }

    function withdrawMaker() external nonReentrant {
        uint256 a = owedMaker;
        if (a == 0) revert NothingOwed();
        owedMaker = 0;
        _send(maker, a);
    }

    // ------------------------------------------------------------------------------------------------------
    // Dissolution
    // ------------------------------------------------------------------------------------------------------

    /// @notice Why the vault can be dissolved right now ("" if it can't).
    function dissolvable() public view returns (string memory) {
        if (dissolved) return "";
        if (totalShares > 0 && dissolveVotes * BPS >= totalShares * dissolveBps) return "backers voted";
        if (isQuest() && !funded && block.timestamp > fundingDeadline) return "funding target missed";
        if (isQuest() && funded && block.timestamp > questDeadline) return "quest deadline passed";
        if (funded && block.timestamp > lastCheckIn + inactivityPeriod) return "gremlin went quiet";
        return "";
    }

    /// @notice Anyone may dissolve when `dissolvable()` gives a reason; the gremlin may dissolve at any time.
    function dissolve() external {
        if (dissolved) revert Closed();
        string memory reason = msg.sender == gremlin ? "gremlin dissolved it" : dissolvable();
        if (bytes(reason).length == 0) revert NotDissolvable();
        _dissolve(reason);
    }

    // ------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------

    function _pendingFee() internal view returns (uint256) {
        if (!funded || dissolved || mgmtFeeBps == 0) return 0;
        uint256 fee = (capital * mgmtFeeBps * (block.timestamp - lastAccrual)) / (BPS * YEAR);
        return fee < capital ? fee : capital;
    }

    function _accrue() internal {
        uint256 fee = _pendingFee();
        lastAccrual = block.timestamp;
        if (fee == 0) return;
        capital -= fee;
        owedGremlin += fee;
        emit FeeAccrued(fee);
    }

    function _rollEpoch() internal {
        uint256 epoch = block.timestamp / EPOCH;
        if (epoch != epochIndex) {
            epochIndex = epoch;
            epochStartCapital = capital;
            drawnThisEpoch = 0;
        }
    }

    function _income(address from, uint256 amount) internal {
        if (amount == 0) return;
        if (dissolved || totalShares == 0) {
            // after dissolution everything belongs to backers; before anyone backs it, to the gremlin
            if (dissolved && totalShares > 0) {
                emit Income(from, amount, 0, 0, amount);
                _distribute(amount);
            } else {
                owedGremlin += amount;
                emit Income(from, amount, 0, amount, 0);
            }
            return;
        }
        uint256 toMaker = (amount * makerBps) / BPS;
        uint256 toGremlin = (amount * incomeKeepBps) / BPS;
        uint256 toBackers = amount - toMaker - toGremlin;
        owedMaker += toMaker;
        owedGremlin += toGremlin;
        emit Income(from, amount, toMaker, toGremlin, toBackers);
        _distribute(toBackers);
    }

    function _distribute(uint256 amount) internal {
        if (totalShares == 0) {
            owedGremlin += amount;
            return;
        }
        uint256 total = amount + dust;
        uint256 perShare = (total * MAG) / totalShares;
        uint256 assigned = (perShare * totalShares) / MAG;
        magnifiedPerShare += perShare;
        dividendLiability += assigned;
        dust = total - assigned;
    }

    function _mint(address to, uint256 amount) internal {
        totalShares += amount;
        shares[to] += amount;
        corrections[to] -= int256(magnifiedPerShare * amount);
        if (votedDissolve[to]) dissolveVotes += amount;
    }

    function _dissolve(string memory reason) internal {
        _accrue();
        dissolved = true;
        uint256 back = capital;
        capital = 0;
        emit Dissolved(reason, back);
        if (back > 0) _distribute(back);
    }

    function _send(address to, uint256 amount) internal {
        emit Withdrawn(to, amount);
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
