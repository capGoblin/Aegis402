// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CreditManager
 * @notice Capital-backed credit layer for x402 agents
 */
contract CreditManager is Ownable {
    IERC20 public immutable USDC;
    address public aegis402Agent;

    constructor(address _usdc, address _aegis402Agent) Ownable(msg.sender) {
        USDC = IERC20(_usdc);
        aegis402Agent = _aegis402Agent;
    }

    modifier onlyAegis402() {
        require(msg.sender == aegis402Agent, "Not Aegis402 agent");
        _;
    }

    struct Merchant {
        uint256 stake;
        uint256 creditLimit;
        uint256 outstandingExposure;
        uint256 agentId;
        string x402Endpoint;
        string[] skills;
        bool active;
    }

    mapping(address => Merchant) public merchants;

    event Subscribed(address indexed merchant, uint256 stake, uint256 agentId);
    event CreditUpdated(address indexed merchant, uint256 creditLimit);
    event ExposureIncreased(address indexed merchant, uint256 amount);
    event ExposureCleared(address indexed merchant, uint256 amount);
    event Slashed(address indexed merchant, address indexed client, uint256 amount);
    event Unstaked(address indexed merchant, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                            MERCHANT FLOW
    //////////////////////////////////////////////////////////////*/

    function setCreditLimit(address merchant, uint256 creditLimit) external onlyAegis402 {
        require(merchants[merchant].active, "Not active");
        merchants[merchant].creditLimit = creditLimit;
        emit CreditUpdated(merchant, creditLimit);
    }

    /**
     * @notice Agent subscribes a merchant (after receiving stake via x402)
     * @dev Agent must have received stakeAmount via facilitator and approved this contract
     */
    function subscribeFor(
        address merchant,
        uint256 stakeAmount,
        uint256 agentId,
        string calldata x402Endpoint,
        string[] calldata skills
    ) external onlyAegis402 {
        require(stakeAmount > 0, "Zero stake");
        require(!merchants[merchant].active, "Already subscribed");

        // Transfer stake from agent to contract (agent received via x402)
        USDC.transferFrom(msg.sender, address(this), stakeAmount);

        merchants[merchant].stake = stakeAmount;
        merchants[merchant].creditLimit = 0;
        merchants[merchant].outstandingExposure = 0;
        merchants[merchant].agentId = agentId;
        merchants[merchant].x402Endpoint = x402Endpoint;
        merchants[merchant].active = true;
        
        // Copy skills array
        for (uint i = 0; i < skills.length; i++) {
            merchants[merchant].skills.push(skills[i]);
        }

        emit Subscribed(merchant, stakeAmount, agentId);
    }

    /// @notice Get merchant's skills (cannot be returned via auto-generated getter)
    function getMerchantSkills(address merchant) external view returns (string[] memory) {
        return merchants[merchant].skills;
    }

    /**
     * @notice Agent increases merchant's stake (via x402 payment)
     */
    function increaseStakeFor(address merchant, uint256 amount) external onlyAegis402 {
        Merchant storage m = merchants[merchant];
        require(m.active, "Not active");
        require(amount > 0, "Zero amount");

        USDC.transferFrom(msg.sender, address(this), amount);
        m.stake += amount;

        emit Subscribed(merchant, m.stake, m.agentId);
    }

    /*//////////////////////////////////////////////////////////////
                        X402 PAYMENT TRACKING
    //////////////////////////////////////////////////////////////*/

    function recordPayment(address merchant, uint256 amount) external onlyAegis402 {
        Merchant storage m = merchants[merchant];
        require(m.active, "Not active");
        require(m.outstandingExposure + amount <= m.creditLimit, "Credit exceeded");

        m.outstandingExposure += amount;
        emit ExposureIncreased(merchant, amount);
    }

    function clearExposure(address merchant, uint256 amount) external onlyAegis402 {
        Merchant storage m = merchants[merchant];
        require(m.outstandingExposure >= amount, "Invalid amount");

        m.outstandingExposure -= amount;
        emit ExposureCleared(merchant, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            SLASHING
    //////////////////////////////////////////////////////////////*/

    function slash(address merchant, address client, uint256 amount) external onlyAegis402 {
        Merchant storage m = merchants[merchant];
        require(m.stake >= amount, "Insufficient stake");
        require(m.outstandingExposure >= amount, "No exposure");

        m.stake -= amount;
        m.outstandingExposure -= amount;

        USDC.transfer(client, amount);
        emit Slashed(merchant, client, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            UNSTAKE
    //////////////////////////////////////////////////////////////*/

    function unstake(uint256 amount) external {
        Merchant storage m = merchants[msg.sender];
        require(m.active, "Not active");

        uint256 freeStake = m.stake - m.outstandingExposure;
        require(amount <= freeStake, "Stake locked");

        m.stake -= amount;
        USDC.transfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function availableCapacity(address merchant) external view returns (uint256) {
        Merchant storage m = merchants[merchant];
        if (!m.active) return 0;
        if (m.creditLimit <= m.outstandingExposure) return 0;
        return m.creditLimit - m.outstandingExposure;
    }
}
