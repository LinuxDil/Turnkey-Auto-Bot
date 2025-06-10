import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com/";
const CONFIG_FILE = "config.json";
const isDebug = false;

let walletInfo = {
  address: "N/A",
  balanceETH: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let privateKeys = [];
let proxies = [];
let recipientWallets = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  sendRepetitions: 1,
  minEth: 0.0001,
  maxEth: 0.0002
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.sendRepetitions = Number(config.sendRepetitions) || 1;
      dailyActivityConfig.minEth = Number(config.minEth) || 0.0001;
      dailyActivityConfig.maxEth = Number(config.maxEth) || 0.0002;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}, using default settings.`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent(''); 
  addLog("Transaction logs cleared.", "success");
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(key => key.trim()).filter(key => key.match(/^(0x)?[0-9a-fA-F]{64}$/));
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "warn");
    proxies = [];
  }
}

function loadRecipientWallets() {
  try {
    const data = fs.readFileSync("wallet.txt", "utf8");
    recipientWallets = data.split("\n").map(addr => addr.trim()).filter(addr => ethers.isAddress(addr));
    if (recipientWallets.length === 0) throw new Error("No valid addresses in wallet.txt");
    addLog(`Loaded ${recipientWallets.length} wallets from wallet.txt`, "success");
  } catch (error) {
    addLog(`Failed to load recipient wallets: ${error.message}`, "error");
    recipientWallets = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProviderWithProxy(proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 11155111, name: "Sepolia" }, { fetchOptions });
      provider.getNetwork().then(network => {
      });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(2000);
    }
  }
  try {
    addLog(`Proxy failed, falling back to direct connection`, "warn");
    const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 11155111, name: "Sepolia" });
    provider.getNetwork().then(network => {
    });
    return provider;
  } catch (error) {
    addLog(`Fallback failed: ${error.message}`, "error");
    throw new Error("Failed to initialize provider after retries");
  }
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl);
      const wallet = new ethers.Wallet(privateKey, provider);
      
      const ethBalance = await provider.getBalance(wallet.address);
      const formattedEth = Number(ethers.formatEther(ethBalance)).toFixed(4);
      
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}               ${chalk.bold.greenBright(formattedEth.padEnd(8))}`;
      
      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceETH = formattedEth;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000`;
    }
  });
  const walletData = await Promise.all(walletDataPromises);
  addLog("Wallet data updated.", "info");
  return walletData;
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    nonceTracker[walletAddress] = nextNonce;
    return nextNonce;
  } catch (error) {
    addLog(`Error fetching nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function runDailyActivity() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return;
  }
  if (recipientWallets.length === 0) {
    addLog("No valid wallets found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Send: ${dailyActivityConfig.sendRepetitions}`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      let provider;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}...`, "info");
      try {
        provider = getProviderWithProxy(proxyUrl);
        await provider.getNetwork();
      } catch (error) {
        addLog(`Failed to connect to provider for account ${accountIndex + 1}: ${error.message}`, "error");
        continue;
      }
      const wallet = new ethers.Wallet(privateKeys[accountIndex], provider);
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");
      
      for (let sendCount = 1; sendCount <= dailyActivityConfig.sendRepetitions && !shouldStop; sendCount++) {
        const recipient = recipientWallets[Math.floor(Math.random() * recipientWallets.length)];
        const amountEth = (Math.random() * (dailyActivityConfig.maxEth - dailyActivityConfig.minEth) + dailyActivityConfig.minEth).toFixed(6);
        const amountWei = ethers.parseEther(amountEth);
        
        try {
          const balance = await provider.getBalance(wallet.address);
          addLog(`Account ${accountIndex + 1} - Send ${sendCount}: Current balance: ${ethers.formatEther(balance)} ETH`, "wait");
          const gasPrice = (await provider.getFeeData()).maxFeePerGas || ethers.parseUnits("1", "gwei");
          const gasLimit = 21000;
          const gasCost = gasPrice * BigInt(gasLimit);
          if (balance < (amountWei + gasCost)) {
            addLog(`Account ${accountIndex + 1} - Send ${sendCount}: Insufficient balance (${ethers.formatEther(balance)} ETH)`, "error");
            continue;
          }
          
          const nonce = await getNextNonce(provider, wallet.address);
          const feeData = await provider.getFeeData();
          const tx = await wallet.sendTransaction({
            to: recipient,
            value: amountWei,
            gasLimit: 21000,
            maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits("1", "gwei"),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits("0.5", "gwei"),
            nonce,
            chainId: 11155111
          });
          addLog(`Account ${accountIndex + 1} - Send ${sendCount}: Transaction sent to ${getShortAddress(recipient)} for ${amountEth} ETH. Hash: ${getShortHash(tx.hash)}`, "success");
          await tx.wait();
          addLog(`Account ${accountIndex + 1} - Send ${sendCount}: Transaction confirmed. Hash: ${getShortHash(tx.hash)}`, "success");
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Send ${sendCount}: Failed to send transaction: ${error.message}`, "error");
        }
        
        if (sendCount < dailyActivityConfig.sendRepetitions && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next send...`, "delay");
          await sleep(randomDelay);
        }
      }
      
      if (accountIndex < privateKeys.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          if (dailyActivityInterval) {
            clearTimeout(dailyActivityInterval);
            dailyActivityInterval = null;
            addLog("Cleared daily activity interval.", "info");
          }
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog(`Daily activity stopped successfully.`, "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "SEP ETH AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 1000,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: ["Set Auto Send", "Set ETH Range", "Back to Main Menu"],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minEthLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min ETH:",
  style: { fg: "white" }
});

const maxEthLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max ETH:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("Airdrop Seeker", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
  const status = activityRunning
    ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
    : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
  const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Auto Send: ${dailyActivityConfig.sendRepetitions}x | TURNKEY AUTO BOT | FOLLOW BG WIN`;
  try {
    statusBox.setContent(statusText);
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
  if (isProcessing) {
    if (blinkCounter % 1 === 0) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
  }
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `${chalk.bold.cyan("     Address".padEnd(12))}                    ${chalk.bold.cyan("ETH".padEnd(8))}`;
  const separator = chalk.gray("-".repeat(45));
  try {
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
  } catch (error) {
    addLog(`Wallet update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("Tidak ada log tersedia."));
    logBox.setScrollPerc(100);
  } catch (error) {
    addLog(`Log update error: ${error.message}`, "error");
  }
  safeRender();
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
  } catch (error) {
    addLog(`Menu update error: ${error.message}`, "error");
  }
  safeRender();
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async item => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity... Please wait for ongoing process to complete.", "info");
      safeRender();
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
  if (action !== "Set Manual Config") {
    menuBox.focus();
    menuBox.style.border.fg = "yellow";
    logBox.style.border.fg = "magenta";
    safeRender();
  }
});

dailyActivitySubMenu.on("select", item => {
  const action = item.getText();
  switch (action) {
    case "Set Auto Send":
      configForm.configType = "sendRepetitions";
      configForm.setLabel(" Enter Send Repetitions ");
      minEthLabel.hide();
      maxEthLabel.hide();
      configInput.setValue(dailyActivityConfig.sendRepetitions.toString());
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Set ETH Range":
      configForm.configType = "ethRange";
      configForm.setLabel(" Enter ETH Range ");
      minEthLabel.show();
      maxEthLabel.show();
      configInput.setValue(dailyActivityConfig.minEth.toString());
      configInputMax.setValue(dailyActivityConfig.maxEth.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "yellow";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

configInput.key(["enter"], () => {
  if (configForm.configType === "ethRange") {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
    screen.focusPush(configSubmitButton);
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
  screen.focusPush(configSubmitButton);
});

configForm.on("submit", () => {
  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = parseFloat(inputValue);
    if (configForm.configType === "ethRange") {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max ETH value. Please enter a positive number.", "error");
        configInputMax.setValue("");
        screen.focusPush(configInputMax);
        safeRender();
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.setValue("");
    screen.focusPush(configInput);
    safeRender();
    return;
  }

  if (configForm.configType === "sendRepetitions") {
    dailyActivityConfig.sendRepetitions = Math.floor(value);
    addLog(`Auto Send set to ${dailyActivityConfig.sendRepetitions}`, "success");
  } else if (configForm.configType === "ethRange") {
    if (value > maxValue) {
      addLog("Min ETH cannot be greater than Max ETH.", "error");
      configInput.setValue("");
      configInputMax.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minEth = value;
    dailyActivityConfig.maxEth = maxValue;
    addLog(`ETH Range set to ${dailyActivityConfig.minEth} - ${dailyActivityConfig.maxEth}`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "yellow";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  loadConfig();
  loadPrivateKeys();
  loadProxies();
  loadRecipientWallets();
  updateStatus();
  await updateWallets();
  updateLogs();
  safeRender();
  menuBox.focus();
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
