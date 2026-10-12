// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PatronBox
 * @notice Patrons: people who support a gremlin for nothing in return except a voice and public credit. Gifts go
 * entirely to the gremlin (pull payment). The box records how much each patron gave, which the board uses to weigh
 * patrons' votes and to credit them. No admin; the gremlin is immutable.
 */
contract PatronBox is ReentrancyGuard {
    address public immutable gremlin;
    mapping(address => uint256) public given;
    uint256 public totalGiven;
    uint256 public patronCount;
    uint256 public owed;

    event Gift(address indexed patron, uint256 amount, string note);
    event Withdrawn(uint256 amount);

    error ZeroAddress();
    error NothingOwed();
    error TransferFailed();

    constructor(address gremlin_) {
        if (gremlin_ == address(0)) revert ZeroAddress();
        gremlin = gremlin_;
    }

    receive() external payable {
        _gift("");
    }

    /// @notice Give with a public note (shown on the gremlin's profile).
    function give(string calldata note) external payable {
        _gift(note);
    }

    /// @notice Sends everything given so far to the gremlin. Callable by anyone.
    function withdraw() external nonReentrant {
        uint256 a = address(this).balance;
        if (a == 0) revert NothingOwed();
        owed = 0;
        emit Withdrawn(a);
        (bool ok, ) = payable(gremlin).call{value: a}("");
        if (!ok) revert TransferFailed();
    }

    function _gift(string memory note) internal {
        if (msg.value == 0) return;
        if (given[msg.sender] == 0) patronCount++;
        given[msg.sender] += msg.value;
        totalGiven += msg.value;
        owed += msg.value;
        emit Gift(msg.sender, msg.value, note);
    }
}
