pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract PvpMatchFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error BatchClosed();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidSubmission();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PlayerScoreSubmitted(address indexed player, uint256 indexed batchId, bytes32 encryptedScore);
    event MatchmakingRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event MatchmakingCompleted(uint256 indexed requestId, uint256 indexed batchId, address player1, address player2, uint32 score1, uint32 score2);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct PlayerSubmission {
        euint32 encryptedScore;
        uint256 submissionTimestamp;
    }

    struct MatchRequest {
        address player1;
        address player2;
        euint32 encryptedScore1;
        euint32 encryptedScore2;
        uint256 requestTimestamp;
    }

    uint256 public constant MIN_COOLDOWN_SECONDS = 10;
    uint256 public cooldownSeconds = 30;

    address public owner;
    bool public paused;
    uint256 public currentBatchId = 0;
    bool public batchOpen = false;

    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTimestamp;
    mapping(address => uint256) public lastRequestTimestamp;
    mapping(uint256 => mapping(address => PlayerSubmission)) public batchSubmissions;
    mapping(uint256 => MatchRequest) public matchRequests;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown(address player) {
        if (block.timestamp < lastSubmissionTimestamp[player] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkRequestCooldown(address player) {
        if (block.timestamp < lastRequestTimestamp[player] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds < MIN_COOLDOWN_SECONDS) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchNotOpen();
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchClosed();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitPlayerScore(
        address player,
        uint32 score
    ) external onlyProvider whenNotPaused checkSubmissionCooldown(player) {
        if (!batchOpen) revert BatchClosed();
        _initIfNeeded();
        euint32 memory encryptedScore = FHE.asEuint32(score);
        batchSubmissions[currentBatchId][player] = PlayerSubmission(encryptedScore, block.timestamp);
        lastSubmissionTimestamp[player] = block.timestamp;
        emit PlayerScoreSubmitted(player, currentBatchId, encryptedScore.toBytes32());
    }

    function findMatch(
        address player1,
        address player2
    ) external onlyProvider whenNotPaused checkRequestCooldown(player1) {
        if (player1 == player2) revert InvalidSubmission();
        if (batchSubmissions[currentBatchId][player1].encryptedScore.isZero() || batchSubmissions[currentBatchId][player2].encryptedScore.isZero()) {
            revert InvalidSubmission();
        }

        PlayerSubmission storage sub1 = batchSubmissions[currentBatchId][player1];
        PlayerSubmission storage sub2 = batchSubmissions[currentBatchId][player2];

        euint32 memory diff = sub1.encryptedScore.sub(sub2.encryptedScore);
        euint32 memory absDiff = diff.ge(FHE.asEuint32(0)).select(diff, FHE.asEuint32(0).sub(diff));

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = absDiff.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        matchRequests[requestId] = MatchRequest(player1, player2, sub1.encryptedScore, sub2.encryptedScore, block.timestamp);
        decryptionContexts[requestId] = DecryptionContext(currentBatchId, stateHash, false);
        lastRequestTimestamp[player1] = block.timestamp;

        emit MatchmakingRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // Rebuild ciphertexts in the exact same order as during request
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = matchRequests[requestId].encryptedScore1.sub(matchRequests[requestId].encryptedScore2)
            .ge(FHE.asEuint32(0))
            .select(
                matchRequests[requestId].encryptedScore1.sub(matchRequests[requestId].encryptedScore2),
                FHE.asEuint32(0).sub(matchRequests[requestId].encryptedScore1.sub(matchRequests[requestId].encryptedScore2))
            )
            .toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint32 scoreDiff = abi.decode(cleartexts, (uint32));
        decryptionContexts[requestId].processed = true;

        emit MatchmakingCompleted(
            requestId,
            decryptionContexts[requestId].batchId,
            matchRequests[requestId].player1,
            matchRequests[requestId].player2,
            matchRequests[requestId].encryptedScore1.toUint32(),
            matchRequests[requestId].encryptedScore2.toUint32()
        );
    }
}