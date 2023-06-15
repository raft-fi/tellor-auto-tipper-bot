export const API_MAX_TRIES = 10 // max number of times to retry api calls
export const BASE_TOKEN_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
export const BASE_TOKEN_PRICE_URL_SELECTOR = "ethereum"
export const GAS_PRICE_URL = "https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey="
export const INITIAL_PROFIT_MARGIN_USD = 2.0 // usd
export const MAX_RETIP_COUNT = 3 // max number of times to retry a tip
export const ORACLE_TOKEN_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=tellor&vs_currencies=usd"
export const ORACLE_TOKEN_PRICE_URL_SELECTOR = "tellor"
export const TIP_MULTIPLIER = 1.10 // multiplier for each tip retry
export const TOKEN_APPROVAL_AMOUNT = 1000000000000000000000n // amount of oracle token to approve for autopay contract
export const TOTAL_GAS_COST = 700000 // cost of submitValue + claimTip
export const QUERY_ID = ""
export const QUERY_DATA = ""
