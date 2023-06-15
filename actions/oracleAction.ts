import {
	ActionFn,
	Context
} from '@tenderly/actions';
import AutopayABI from "./abi/Autopay.json";
import ERC20ContractABI from "./abi/ERC20.json";
import TellorPriceOracleABI from "./abi/TellorPriceOracle.json";
import axios from 'axios';
import { ethers, Contract } from 'ethers';
import { 
    API_MAX_TRIES,
    BASE_TOKEN_PRICE_URL,
    BASE_TOKEN_PRICE_URL_SELECTOR,
    GAS_PRICE_URL,
    INITIAL_PROFIT_MARGIN_USD,
    //MAX_RETIP_COUNT,
    ORACLE_TOKEN_PRICE_URL,
    ORACLE_TOKEN_PRICE_URL_SELECTOR,
    QUERY_DATA,
    QUERY_ID,
    TIP_MULTIPLIER,
    TOKEN_APPROVAL_AMOUNT,
    TOTAL_GAS_COST  
} from './config/generalConfig';
import { 
  AUTOPAY_CONTRACT_ADDRESS, 
  PROVIDER_URL, 
  TELLOR_PRICE_ORACLE_ADDRESS,
  TELLOR_TOKEN_ADDRESS
} from './config/networkConfig';

const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);

const autopayContract = new Contract(
  AUTOPAY_CONTRACT_ADDRESS,
  AutopayABI.abi,
  provider
);
const tellorPriceOracleContract = new Contract(
  TELLOR_PRICE_ORACLE_ADDRESS,
  TellorPriceOracleABI.abi,
  provider
);
const tellorTokenContract = new Contract(
  TELLOR_TOKEN_ADDRESS,
  ERC20ContractABI.abi,
  provider
);

let account: ethers.Wallet;

export const triggerAutoTipperBotFn: ActionFn = async (context: Context) => {
    // To access project's secret
    let acctPrivateKey = await context.secrets.get('RAFT_ACCOUNT');
    account = new ethers.Wallet(acctPrivateKey, provider);
    console.log('account:', account.address);

    let balances = await approveTokenAndCheckBalance();
    let initTipBool = true;
    if (balances[0] == 0n) {
      console.error(`zero ${ORACLE_TOKEN_PRICE_URL_SELECTOR} oracle token balance`);
      initTipBool = false;
    }
    if (balances[1] == 0n) {
      console.error(`zero ${BASE_TOKEN_PRICE_URL_SELECTOR} base token balance`);
      initTipBool = false;
    }
    if (initTipBool) {
      // initiate tipping sequence
      console.info('initiating tipping sequence');
      const lastReportTime = await getLastReportTime();
      await initiateTippingSequence(
        0,
        lastReportTime,
        balances
      );
    }
}

async function sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

async function getGasCostInOracleToken(): Promise<[number, number]> {
  try {
    const responseBaseToken = await axios.get(BASE_TOKEN_PRICE_URL);
    const responseJsonBaseToken = responseBaseToken.data;
    const baseTokenPrice = responseJsonBaseToken[BASE_TOKEN_PRICE_URL_SELECTOR]['usd'];
    console.log('base token price:', baseTokenPrice);

    const responseOracleToken = await axios.get(ORACLE_TOKEN_PRICE_URL);
    const responseJsonOracleToken = responseOracleToken.data;
    const oracleTokenPrice = responseJsonOracleToken[ORACLE_TOKEN_PRICE_URL_SELECTOR]['usd'];
    const trbPrice = oracleTokenPrice;
    console.log('oracle token price:', oracleTokenPrice);

    const responseGasPrice = await axios.get(GAS_PRICE_URL);
    const responseJsonGasPrice = responseGasPrice.data;
    const gasPrice = parseFloat(responseJsonGasPrice['result']['FastGasPrice']);
    console.log('gas price:', gasPrice);

    const gasCostUsd = (TOTAL_GAS_COST * gasPrice * baseTokenPrice) / 1000000000;
    console.log('gas cost in usd:', gasCostUsd);

    const gasCostOracleToken =
      (gasPrice * TOTAL_GAS_COST * baseTokenPrice) / oracleTokenPrice / 1000000000;

    return [gasCostOracleToken, trbPrice];
  } catch (error) {
    console.error('error getting gas cost in TRB');
    return [0.0, 0.0];
  }
}

async function getRequiredTip(tryCount: number): Promise<number> {
  let [gasCostTrb, trbPrice] = await getGasCostInOracleToken();

  // handle API errors with limited retries
  let apiTryCount = 0;

  while (trbPrice === 0.0 && apiTryCount < API_MAX_TRIES) {
    const sleepTime = 5 * Math.pow(2, apiTryCount);
    console.warn(`trb price is 0, trying again in ${sleepTime} seconds`);
    await sleep(sleepTime * 1000);
    [gasCostTrb, trbPrice] = await getGasCostInOracleToken();
    apiTryCount += 1;
  }

  console.info('gas cost in trb:', gasCostTrb);
  console.info('initial profit margin usd:', INITIAL_PROFIT_MARGIN_USD);
  console.info('trb price:', trbPrice);
  console.info('tip multiplier:', TIP_MULTIPLIER);
  console.info('try count:', tryCount);

  if (trbPrice === 0.0) {
    return 0.0;
  }

  // calculate required tip
  const requiredTip = (gasCostTrb + INITIAL_PROFIT_MARGIN_USD / trbPrice) * Math.pow(TIP_MULTIPLIER, tryCount);
  return requiredTip;
}

async function approveTokenAndCheckBalance(): Promise<[bigint, bigint]> {
  // check token allowance
  const tokenAllowance = await tellorTokenContract.allowance(account.address, autopayContract.address);
  console.log('token allowance:', tokenAllowance.toString());
  if (tokenAllowance < TOKEN_APPROVAL_AMOUNT / 10n) {
    // approve token allowance
    console.log('approving token amount:', TOKEN_APPROVAL_AMOUNT.toString());

    let interfaceERC20ContractABI = new ethers.utils.Interface(ERC20ContractABI.abi);
    const tx = interfaceERC20ContractABI.encodeFunctionData("approve", [ autopayContract.address, TOKEN_APPROVAL_AMOUNT]);
    let transaction;

    try {
      // get gas estimate
      const gasEstimate = await provider.estimateGas({
        to: tellorTokenContract.address,
        data: tx,
      });

      console.log('gas estimate:', gasEstimate.toString());

      // build transaction object
      transaction = {
        from: account.address,
        to: tellorTokenContract.address,
        data: tx,
        gasLimit: gasEstimate,
        nonce: await provider.getTransactionCount(account.address),
      };
    } catch (error) {
      console.error('error building transaction');
      console.error('building legacy transaction');

      // build legacy transaction object
      transaction = {
        from: account.address,
        to: tellorTokenContract.address,
        data: tx,
        gasPrice: await provider.getGasPrice(),
        nonce: await provider.getTransactionCount(account.address),
      };
    }

    // send transaction
    const txHash = await account.sendTransaction(transaction);

    console.log('transaction hash:', txHash.hash);

    // wait for transaction to be mined
    await provider.waitForTransaction(txHash.hash);
  }

  const oracleTokenBalance = await tellorTokenContract.balanceOf(account.address);

  console.log(
    `${ORACLE_TOKEN_PRICE_URL_SELECTOR} token balance:`,
    oracleTokenBalance.toString()
  );

  const baseTokenBalance = await account.getBalance();

  console.log(
    `${BASE_TOKEN_PRICE_URL_SELECTOR} token balance:`,
    baseTokenBalance.toString()
  );

  return [oracleTokenBalance, baseTokenBalance.toBigInt()];
}

async function initiateTippingSequence(
  retipCount: number,
  lastReportTime: number,
  balances: [bigint, bigint]
): Promise<void> {
  // calculate required tip
  const requiredTip = await getRequiredTip(retipCount);
  console.info("required tip:", requiredTip);

  if (requiredTip == 0.0) {
    console.error("error getting required tip, exiting");
    return;
  }

  // get current tip
  const currentTip = await autopayContract.getCurrentTip(QUERY_ID);
  console.info("current tip:", currentTip.toString());

  // call getDataBefore function, check for new report since tipping sequence started
  let currentTimestamp = Math.floor(Date.now() / 1000);
  let dataBefore = await tellorPriceOracleContract.getDataBefore(QUERY_ID, currentTimestamp);
  let lastReportTimeUpdated = parseInt(dataBefore[2]);
  console.info("last report time updated:", lastReportTimeUpdated);
  console.info("last report time previous:", lastReportTime);

  // check if current tip is less than required tip or last report time has not changed
  let amountToTip = 0n;
  if (currentTip < requiredTip * 1e18 || lastReportTimeUpdated == lastReportTime) {
    // calculate tip amount
    amountToTip = BigInt(requiredTip * 1e18 - currentTip);
    if (amountToTip < 0) {
      amountToTip = 0n;
    }
    console.info("amount to tip:", amountToTip.toString());

    // check if oracle token balance is zero
    if (balances[0] == 0n) {
      console.error(`zero ${ORACLE_TOKEN_PRICE_URL_SELECTOR} oracle token balance, exiting`);
      return;
    }
    // check if oracle token balance is less than amount to tip
    if (balances[0] < amountToTip) {
      console.warn(`not enough ${ORACLE_TOKEN_PRICE_URL_SELECTOR} oracle token balance to tip`);
      console.warn(`using all ${ORACLE_TOKEN_PRICE_URL_SELECTOR} oracle token balance to tip`);
      amountToTip = balances[0];
      console.info("new amount to tip:", amountToTip.toString());
    }

    if (amountToTip > 0) {
      await tip(amountToTip);
    }

    // This is currently not possible to run because of Tenderly 30 second timeout
    // If delete `await sleep(45 * 1000);`, `getDataBefore` will not be updated
    /*
    console.info("sleeping %s seconds...", 45);
    await sleep(45 * 1000);

    // call getDataBefore function
    currentTimestamp = Math.floor(Date.now() / 1000);
    dataBefore = await tellorPriceOracleContract.getDataBefore(QUERY_ID, currentTimestamp);
    lastReportTimeUpdated = parseInt(dataBefore[2]);
    console.info("last report time updated:", lastReportTimeUpdated);
    console.info("last report time previous:", lastReportTime);

    // check if data is available
    if (lastReportTimeUpdated <= lastReportTime) {
      console.info("no new data reported");
      // check if try count is less than max try count
      if (retipCount < MAX_RETIP_COUNT) {
        balances = await approveTokenAndCheckBalance();
        // initiate tipping sequence again
        console.info(`try count ${retipCount} is less than max try count ${MAX_RETIP_COUNT}`);
        console.info("initiating tipping sequence again");
        await initiateTippingSequence(
          retipCount + 1,
          lastReportTime,
          balances
        );
      }
    } else {
      console.info("new data reported");
    }
    */
  }
}

async function tip(amountToTip: bigint): Promise<void> {
  console.info("tipping:", amountToTip.toString());

  const iface = new ethers.utils.Interface(AutopayABI.abi);
  const tx = iface.encodeFunctionData("tip", [QUERY_ID, amountToTip, QUERY_DATA]);

  const transaction = {
    from: account.address,
    to: autopayContract.address,
    data: tx,
    gasPrice: (await provider.getGasPrice()).toBigInt() * 12n / 10n,
    nonce: await provider.getTransactionCount(account.address),
  };

  const txHash = await account.sendTransaction(transaction);

  console.log('transaction hash:', txHash.hash);

  // wait for transaction to be mined
  await provider.waitForTransaction(txHash.hash);
}

// function for getting last report time for given query id
async function getLastReportTime(): Promise<number> {
  try {
    const dataBefore = await tellorPriceOracleContract.getDataBefore(
      QUERY_ID,
      Math.floor(Date.now() / 1000)
    );
    const timestampRetrieved = parseInt(dataBefore[2]);
    console.info("last report time:", timestampRetrieved);
    return timestampRetrieved;
  } catch (error) {
    console.warn("error getting data before");
    return 0;
  }
}
