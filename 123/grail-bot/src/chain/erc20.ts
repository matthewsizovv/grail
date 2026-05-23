import { Contract, Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { getRpcPool } from './rpcPool.js';
import { logger, maskAddress } from '../core/logger.js';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

export const ERC20_IFACE = new Interface(ERC20_ABI);

function getContract(tokenAddress: string, provider: JsonRpcProvider) {
  return new Contract(tokenAddress, ERC20_ABI, provider);
}

export async function balanceOf(tokenAddress: string, walletAddress: string): Promise<bigint> {
  return getRpcPool().call<bigint>((p) => {
    const c = getContract(tokenAddress, p);
    return (c['balanceOf'] as (a: string) => Promise<bigint>)(walletAddress);
  });
}

export async function allowance(
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return getRpcPool().call<bigint>((p) => {
    const c = getContract(tokenAddress, p);
    return (c['allowance'] as (o: string, s: string) => Promise<bigint>)(owner, spender);
  });
}

export async function getDecimals(tokenAddress: string): Promise<number> {
  return getRpcPool().call<number>((p) => {
    const c = getContract(tokenAddress, p);
    return (c['decimals'] as () => Promise<number>)();
  });
}

export async function getSymbol(tokenAddress: string): Promise<string> {
  try {
    return await getRpcPool().call<string>((p) => {
      const c = getContract(tokenAddress, p);
      return (c['symbol'] as () => Promise<string>)();
    });
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Approve spender to spend `amount` of `tokenAddress`.
 * Skips if existing allowance is already sufficient.
 * Returns true if a tx was needed, false if already approved.
 */
export async function ensureApproval(
  wallet: Wallet,
  tokenAddress: string,
  spender: string,
  amount: bigint,
): Promise<{ needed: boolean; currentAllowance: bigint }> {
  const current = await allowance(tokenAddress, wallet.address, spender);

  if (current >= amount) {
    logger.debug(
      {
        wallet: maskAddress(wallet.address),
        token: maskAddress(tokenAddress),
        spender: maskAddress(spender),
        current: current.toString(),
        needed: amount.toString(),
      },
      'Allowance sufficient, skip approve',
    );
    return { needed: false, currentAllowance: current };
  }

  logger.info(
    {
      wallet: maskAddress(wallet.address),
      token: maskAddress(tokenAddress),
      spender: maskAddress(spender),
      current: current.toString(),
      needed: amount.toString(),
    },
    'Allowance insufficient, approval needed',
  );

  return { needed: true, currentAllowance: current };
}

/**
 * Build approve calldata for a given amount.
 * Use MaxUint256 for unlimited approval.
 */
export function buildApproveData(spender: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Build transfer calldata.
 */
export function buildTransferData(to: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [to, amount]);
}

/**
 * Get ETH balance of an address.
 */
export async function getEthBalance(address: string): Promise<bigint> {
  return getRpcPool().call<bigint>((p: JsonRpcProvider) => p.getBalance(address));
}

/**
 * Get all ERC20 token balances for a wallet using a list of addresses.
 * Returns non-zero balances only.
 */
export async function getNonZeroBalances(
  walletAddress: string,
  tokenAddresses: string[],
): Promise<{ address: string; balance: bigint; symbol: string; decimals: number }[]> {
  const results = await Promise.allSettled(
    tokenAddresses.map(async (addr) => {
      const balance = await balanceOf(addr, walletAddress);
      if (balance === 0n) return null;
      const [sym, dec] = await Promise.all([getSymbol(addr), getDecimals(addr)]);
      return { address: addr, balance, symbol: sym, decimals: dec };
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<{ address: string; balance: bigint; symbol: string; decimals: number }> =>
        r.status === 'fulfilled' && r.value !== null,
    )
    .map((r) => r.value);
}
