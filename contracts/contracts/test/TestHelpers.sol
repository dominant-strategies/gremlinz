// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test-only contracts. Not deployed anywhere.

interface ISplitter {
    function lowerBps(uint16 newBps) external;
    function release() external;
}

/// A payee that can be toggled to reject native payments, and can act as a splitter recipient.
contract TogglePayee {
    bool public rejecting = true;
    uint256 public received;

    function setRejecting(bool r) external {
        rejecting = r;
    }

    function lowerBps(ISplitter s, uint16 newBps) external {
        s.lowerBps(newBps);
    }

    receive() external payable {
        require(!rejecting, "nope");
        received += msg.value;
    }
}

/// A payee that tries to re-enter release() when paid.
contract ReentrantPayee {
    ISplitter public splitter;
    bool public reentered;

    function setSplitter(ISplitter s) external {
        splitter = s;
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            splitter.release(); // must revert (nonReentrant) -> this payment fails
        }
    }
}

/// Sends its balance to `target` via selfdestruct in the constructor (a transfer that runs no code).
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// Minimal splitter-shaped contract for registry tests.
contract FakeSplitter {
    address public gremlin;

    constructor(address g) {
        gremlin = g;
    }
}

/// ERC20 with a blocklist so we can simulate a recipient whose transfers fail.
contract MockERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}
