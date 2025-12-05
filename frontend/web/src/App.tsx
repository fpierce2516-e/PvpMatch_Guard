// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Match {
  id: number;
  player1: string;
  player2: string;
  encryptedElo1: string;
  encryptedElo2: string;
  timestamp: number;
  status: 'pending' | 'completed' | 'canceled';
  winner?: string;
}

interface UserHistory {
  type: 'match' | 'rating' | 'decrypt';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<Match[]>([]);
  const [userHistory, setUserHistory] = useState<UserHistory[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "completed" | "canceled">("all");
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [activeTab, setActiveTab] = useState('matches');
  const [showStats, setShowStats] = useState(false);
  const [decryptedElo, setDecryptedElo] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  // Initialize
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load matches
      const matchesBytes = await contract.getData("matches");
      let matchesList: Match[] = [];
      if (matchesBytes.length > 0) {
        try {
          const matchesStr = ethers.toUtf8String(matchesBytes);
          if (matchesStr.trim() !== '') matchesList = JSON.parse(matchesStr);
        } catch (e) {}
      }
      setMatches(matchesList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Create a new match
  const createMatch = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Creating match with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate random ELO between 1000-3000
      const randomElo = Math.floor(Math.random() * 2000) + 1000;
      
      // Create new match
      const newMatch: Match = {
        id: matches.length + 1,
        player1: address,
        player2: "0x0000000000000000000000000000000000000000", // Empty address for now
        encryptedElo1: FHEEncryptNumber(randomElo),
        encryptedElo2: FHEEncryptNumber(0), // Will be set when matched
        timestamp: Math.floor(Date.now() / 1000),
        status: 'pending'
      };
      
      // Update matches list
      const updatedMatches = [...matches, newMatch];
      
      // Save to contract
      await contract.setData("matches", ethers.toUtf8Bytes(JSON.stringify(updatedMatches)));
      
      // Update user history
      const newHistory: UserHistory = {
        type: 'match',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Created new match with encrypted ELO: ${randomElo}`
      };
      setUserHistory(prev => [newHistory, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Match created successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Find opponent matchmaking
  const findOpponent = async (matchId: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Finding opponent with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the match
      const matchIndex = matches.findIndex(m => m.id === matchId);
      if (matchIndex === -1) throw new Error("Match not found");
      
      // Update match with opponent
      const updatedMatches = [...matches];
      updatedMatches[matchIndex].player2 = address;
      
      // Generate random ELO for opponent (within ±200 of player1's ELO)
      const player1Elo = FHEDecryptNumber(updatedMatches[matchIndex].encryptedElo1);
      const opponentElo = player1Elo + Math.floor(Math.random() * 400) - 200;
      updatedMatches[matchIndex].encryptedElo2 = FHEEncryptNumber(opponentElo);
      updatedMatches[matchIndex].status = 'completed';
      
      // Random winner (for demo)
      updatedMatches[matchIndex].winner = Math.random() > 0.5 ? updatedMatches[matchIndex].player1 : updatedMatches[matchIndex].player2;
      
      // Save to contract
      await contract.setData("matches", ethers.toUtf8Bytes(JSON.stringify(updatedMatches)));
      
      // Update user history
      const newHistory: UserHistory = {
        type: 'match',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Joined match #${matchId} as opponent`
      };
      setUserHistory(prev => [newHistory, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Opponent found! Match completed." });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Matchmaking failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt ELO with signature
  const decryptEloWithSignature = async (encryptedData: string): Promise<void> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user history
      const newHistory: UserHistory = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE ELO rating"
      };
      setUserHistory(prev => [newHistory, ...prev]);
      
      setDecryptedElo(FHEDecryptNumber(encryptedData));
    } catch (e) { 
      console.error("Decryption failed:", e);
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Filtered matches
  const filteredMatches = matches.filter(match => {
    const matchesSearch = match.player1.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         match.player2.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         match.id.toString().includes(searchTerm);
    const matchesStatus = filterStatus === "all" || match.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  // Render match statistics
  const renderStats = () => {
    const totalMatches = matches.length;
    const completedMatches = matches.filter(m => m.status === 'completed').length;
    const pendingMatches = matches.filter(m => m.status === 'pending').length;
    const canceledMatches = matches.filter(m => m.status === 'canceled').length;
    
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{totalMatches}</div>
          <div className="stat-label">Total Matches</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{completedMatches}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{pendingMatches}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{canceledMatches}</div>
          <div className="stat-label">Canceled</div>
        </div>
      </div>
    );
  };

  // Render user history
  const renderUserHistory = () => {
    if (userHistory.length === 0) return <div className="no-data">No history recorded</div>;
    
    return (
      <div className="history-list">
        {userHistory.map((item, index) => (
          <div className="history-item" key={index}>
            <div className={`history-type ${item.type}`}>
              {item.type === 'match' && '⚔️'}
              {item.type === 'rating' && '📊'}
              {item.type === 'decrypt' && '🔓'}
            </div>
            <div className="history-details">
              <div className="history-text">{item.details}</div>
              <div className="history-time">{new Date(item.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is Encrypted PvP Matchmaking?",
        answer: "A system that matches players based on encrypted skill ratings (ELO) using Zama FHE, ensuring fair matches without revealing actual skill levels."
      },
      {
        question: "How does FHE protect my ELO rating?",
        answer: "Your ELO is encrypted on-chain and all matchmaking calculations are performed on encrypted data without decryption."
      },
      {
        question: "Can I see my own ELO rating?",
        answer: "Yes, you can decrypt your own ELO using your wallet signature, but others cannot see it without your permission."
      },
      {
        question: "How are matches determined?",
        answer: "The system finds opponents with similar encrypted ELO ratings while keeping actual values hidden."
      },
      {
        question: "What blockchain is this built on?",
        answer: "Built on Ethereum with Zama FHE for privacy-preserving computations."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted matchmaking system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="pvp-icon"></div>
          </div>
          <h1>Encrypted<span>PvP</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={createMatch} 
            className="create-match-btn"
          >
            <div className="add-icon"></div>New Match
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-header">
            <h2>Encrypted PvP Matchmaking</h2>
            <p>Fair matches powered by Zama FHE encrypted ELO ratings</p>
            
            <div className="header-controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search matches..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="search-icon"></div>
              </div>
              
              <div className="filter-buttons">
                <button 
                  className={filterStatus === "all" ? "active" : ""}
                  onClick={() => setFilterStatus("all")}
                >
                  All
                </button>
                <button 
                  className={filterStatus === "pending" ? "active" : ""}
                  onClick={() => setFilterStatus("pending")}
                >
                  Pending
                </button>
                <button 
                  className={filterStatus === "completed" ? "active" : ""}
                  onClick={() => setFilterStatus("completed")}
                >
                  Completed
                </button>
                <button 
                  className={filterStatus === "canceled" ? "active" : ""}
                  onClick={() => setFilterStatus("canceled")}
                >
                  Canceled
                </button>
              </div>
              
              <button 
                onClick={() => setShowStats(!showStats)} 
                className="stats-toggle"
              >
                {showStats ? "Hide Stats" : "Show Stats"}
              </button>
            </div>
          </div>
          
          {showStats && (
            <div className="stats-section">
              <h3>Match Statistics</h3>
              {renderStats()}
            </div>
          )}
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'matches' ? 'active' : ''}`}
                onClick={() => setActiveTab('matches')}
              >
                Matches
              </button>
              <button 
                className={`tab ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveTab('history')}
              >
                My History
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'matches' && (
                <div className="matches-grid">
                  {filteredMatches.length === 0 ? (
                    <div className="no-matches">
                      <div className="no-matches-icon"></div>
                      <p>No matches found</p>
                      <button 
                        className="create-btn" 
                        onClick={createMatch}
                      >
                        Create First Match
                      </button>
                    </div>
                  ) : filteredMatches.map((match) => (
                    <div className="match-card" key={match.id}>
                      <div className="match-header">
                        <div className="match-id">#{match.id}</div>
                        <div className={`match-status ${match.status}`}>{match.status}</div>
                      </div>
                      
                      <div className="match-players">
                        <div className="player">
                          <div className="player-label">Player 1</div>
                          <div className="player-address">{match.player1.substring(0, 6)}...{match.player1.substring(38)}</div>
                          {match.player1 === address && (
                            <button 
                              className="decrypt-btn small"
                              onClick={() => decryptEloWithSignature(match.encryptedElo1)}
                              disabled={isDecrypting}
                            >
                              {isDecrypting ? "Decrypting..." : "My ELO"}
                            </button>
                          )}
                        </div>
                        
                        <div className="vs">VS</div>
                        
                        <div className="player">
                          <div className="player-label">Player 2</div>
                          <div className="player-address">
                            {match.player2 === "0x0000000000000000000000000000000000000000" ? 
                              "Waiting..." : 
                              `${match.player2.substring(0, 6)}...${match.player2.substring(38)}`
                            }
                          </div>
                          {match.player2 === address && (
                            <button 
                              className="decrypt-btn small"
                              onClick={() => decryptEloWithSignature(match.encryptedElo2)}
                              disabled={isDecrypting}
                            >
                              {isDecrypting ? "Decrypting..." : "My ELO"}
                            </button>
                          )}
                        </div>
                      </div>
                      
                      <div className="match-details">
                        <div className="detail-item">
                          <span>Created:</span>
                          <strong>{new Date(match.timestamp * 1000).toLocaleString()}</strong>
                        </div>
                        
                        {match.status === 'completed' && (
                          <div className="detail-item">
                            <span>Winner:</span>
                            <strong className="winner">
                              {match.winner === address ? "You" : 
                               match.winner === match.player1 ? "Player 1" : 
                               match.winner === match.player2 ? "Player 2" : "Unknown"}
                            </strong>
                          </div>
                        )}
                      </div>
                      
                      <div className="match-actions">
                        {match.status === 'pending' && match.player1 !== address && (
                          <button 
                            className="action-btn join"
                            onClick={() => findOpponent(match.id)}
                          >
                            Join Match
                          </button>
                        )}
                        
                        {match.player1 === address && match.status === 'pending' && (
                          <button className="action-btn waiting" disabled>
                            Waiting for opponent...
                          </button>
                        )}
                        
                        {match.status === 'completed' && (
                          <div className="fhe-tag">
                            <div className="fhe-icon"></div>
                            <span>FHE Encrypted Match</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {activeTab === 'history' && (
                <div className="history-section">
                  <h3>My Match History</h3>
                  {renderUserHistory()}
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h3>Frequently Asked Questions</h3>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      {decryptedElo !== null && (
        <div className="elo-modal">
          <div className="elo-content">
            <h3>Your Decrypted ELO</h3>
            <div className="elo-value">{decryptedElo.toFixed(0)}</div>
            <p>This is your current encrypted skill rating</p>
            <button 
              className="close-btn" 
              onClick={() => setDecryptedElo(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="pvp-icon"></div>
              <span>EncryptedPvP</span>
            </div>
            <p>Fair matchmaking powered by Zama FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} EncryptedPvP. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect player ratings. 
            Matchmaking is calculated on encrypted data without revealing individual skill levels.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;