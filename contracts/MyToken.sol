// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("MyToken", "MTK") {
        _mint(msg.sender, initialSupply);
    }

    function transfer(address recipient, uint256 amount) public virtual override returns (bool) {
        // This is where the Aspect will intercept and apply the daily limit
        return super.transfer(recipient, amount);
    }
}
