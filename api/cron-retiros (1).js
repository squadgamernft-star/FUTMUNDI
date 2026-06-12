/**
 * api/cron-retiros.js - GET /api/cron-retiros
 * Processes pending withdrawals every 10 minutes via Vercel Cron
 * Sends USDT from Admin Wallet → Smart Contract → User
 */

const { supabase } = require('./utils/supabase');
const { logger } = require('./utils/logger');
const { handleCors } = require('./utils/cors');
const TonWeb = require('tonweb');
const { LIMITS, WITHDRAWAL_STATUS, TON_SETTINGS, ERROR_MESSAGES } = require('./utils/constants');
const { sleep } = require('./utils/helpers');

const CONTEXT = 'CRON_RETIROS';

/**
 * Initialize TON Admin Wallet from mnemonic
 */
async function initTonWallet() {
  try {
    const mnemonic = (process.env.TON_ADMIN_MNEMONIC || '').trim().split(/\s+/);

    if (mnemonic.length !== 24) {
      throw new Error(`Invalid mnemonic: expected 24 words, got ${mnemonic.length}`);
    }

    const tonweb = new TonWeb(new TonWeb.HttpProvider(TON_SETTINGS.ENDPOINT));
    const keyPair = await TonWeb.mnemonic.mnemonicToKeyPair(mnemonic);

    const adminWallet = new tonweb.wallet.all['v4R2'](tonweb.provider, {
      publicKey: keyPair.publicKey,
    });
    adminWallet._keyPair = keyPair;

    logger.log(CONTEXT, '✅ TON Admin Wallet initialized', {
      address: adminWallet.address,
    });

    return { tonweb, adminWallet };
  } catch (error) {
    logger.error(CONTEXT, 'Failed to initialize TON wallet', error);
    throw error;
  }
}

/**
 * Process single withdrawal
 */
async function processWithdrawal(tonweb, adminWallet, withdrawal) {
  const retiroId = withdrawal.id;
  let timeoutHandle;

  try {
    // Set 30-second timeout for entire operation
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Transaction timeout: exceeded 30 seconds'));
      }, TON_SETTINGS.CONFIRMATION_TIME_MS);
    });

    // Lock withdrawal as processing
    const { error: lockErr, data: updated } = await supabase
      .from('retiros')
      .update({
        estado: WITHDRAWAL_STATUS.PROCESSING,
        intento: (withdrawal.intento || 0) + 1,
        ultimo_intento: new Date().toISOString(),
      })
      .eq('id', retiroId)
      .eq('estado', WITHDRAWAL_STATUS.PENDING)
      .lt('intento', TON_SETTINGS.MAX_RETRIES)
      .select('intento')
      .single();

    if (lockErr || !updated) {
      return {
        id: retiroId,
        ok: false,
        error: 'Could not lock withdrawal or max retries reached',
        intento: withdrawal.intento,
      };
    }

    // Race against timeout
    await Promise.race([
      sendTransaction(tonweb, adminWallet, withdrawal),
      timeoutPromise,
    ]);

    clearTimeout(timeoutHandle);

    // Mark as completed
    await supabase
      .from('retiros')
      .update({
        estado: WITHDRAWAL_STATUS.COMPLETED,
        completado_en: new Date().toISOString(),
      })
      .eq('id', retiroId);

    logger.log(CONTEXT, `✅ Withdrawal ${retiroId} completed`);
    return { id: retiroId, ok: true };
  } catch (error) {
    clearTimeout(timeoutHandle);
    logger.error(CONTEXT, `❌ Withdrawal ${retiroId} failed`, error);

    const currentRetry = (withdrawal.intento || 0) + 1;
    const isLastRetry = currentRetry >= TON_SETTINGS.MAX_RETRIES;

    // Update withdrawal status
    await supabase
      .from('retiros')
      .update({
        estado: isLastRetry ? WITHDRAWAL_STATUS.FAILED : WITHDRAWAL_STATUS.PENDING,
        error_msg: error.message,
        fallido_en: isLastRetry ? new Date().toISOString() : null,
      })
      .eq('id', retiroId)
      .catch((err) => logger.error(CONTEXT, 'Error updating withdrawal status', err));

    // Refund gemas if final attempt failed
    if (isLastRetry) {
      await refundGemas(withdrawal.wallet_address, withdrawal.gemas);
    }

    return {
      id: retiroId,
      ok: false,
      error: error.message,
      intento: currentRetry,
    };
  }
}

/**
 * Send transaction to TON blockchain
 */
async function sendTransaction(tonweb, adminWallet, withdrawal) {
  try {
    const usdtNano = BigInt(Math.floor(withdrawal.usdt * Math.pow(10, TON_SETTINGS.USDT_DECIMALS)));

    if (usdtNano <= 0n) {
      throw new Error(`Invalid USDT amount: ${withdrawal.usdt}`);
    }

    const opcode = 0x946a98b6;

    // Build transaction payload
    const cell = new TonWeb.boc.Cell();
    cell.bits.writeUint(opcode, 32);
    cell.bits.writeAddress(new TonWeb.utils.Address(withdrawal.destino_address));
    cell.bits.writeCoins(usdtNano);

    const seqno = (await adminWallet.methods.seqno().call()) ?? 0;

    // Send transaction
    const transfer = adminWallet.methods.transfer({
      secretKey: adminWallet._keyPair.secretKey,
      toAddress: process.env.CONTRACT_WALLET,
      amount: TonWeb.utils.toNano(TON_SETTINGS.GAS_AMOUNT),
      seqno,
      payload: cell,
      sendMode: 3,
    });

    const txResult = await transfer.send();

    if (!txResult || !txResult.hash) {
      throw new Error('No transaction hash received from TON node');
    }

    const txHash = Buffer.from(txResult.hash).toString('hex');

    // Store transaction hash
    await supabase
      .from('retiros')
      .update({
        tx_hash: txHash,
        enviado_en: new Date().toISOString(),
      })
      .eq('id', withdrawal.id)
      .catch((err) => logger.warn(CONTEXT, 'Failed to store tx hash', err));

    logger.log(CONTEXT, `🔗 Transaction sent`, {
      retiroId: withdrawal.id,
      txHash: txHash.substring(0, 16) + '...',
    });
  } catch (error) {
    throw new Error(`TON transaction failed: ${error.message}`);
  }
}

/**
 * Refund gemas to user if withdrawal fails
 */
async function refundGemas(walletAddress, gemas) {
  try {
    const { data: perfil } = await supabase
      .from('perfiles')
      .select('gemas')
      .eq('wallet_address', walletAddress)
      .single();

    if (!perfil) {
      logger.error(CONTEXT, `Profile not found for refund: ${walletAddress}`);
      return;
    }

    const newGemas = Number(perfil.gemas || 0) + Number(gemas);

    await supabase
      .from('perfiles')
      .update({ gemas: newGemas })
      .eq('wallet_address', walletAddress);

    logger.log(CONTEXT, `🔄 Gemas refunded`, {
      wallet: walletAddress,
      amount: gemas,
      newTotal: newGemas,
    });
  } catch (error) {
    logger.error(CONTEXT, 'Error refunding gemas', error);
  }
}

/**
 * Main handler
 */
module.exports = async (req, res) => {
  // Handle CORS
  if (handleCors(req, res)) return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido',
    });
  }

  // Verify cron secret
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    logger.warn(CONTEXT, 'Unauthorized cron attempt', { token: token.substring(0, 10) + '...' });
    return res.status(401).json({
      ok: false,
      error: ERROR_MESSAGES.UNAUTHORIZED,
    });
  }

  try {
    if (!supabase) {
      logger.error(CONTEXT, 'Supabase not configured');
      return res.status(500).json({
        ok: false,
        error: ERROR_MESSAGES.INTERNAL_ERROR,
      });
    }

    // Initialize TON
    const { tonweb, adminWallet } = await initTonWallet();

    logger.log(CONTEXT, '🚀 Cron job started');

    // Fetch pending withdrawals
    const { data: retiros, error: fetchErr } = await supabase
      .from('retiros')
      .select('*')
      .eq('estado', WITHDRAWAL_STATUS.PENDING)
      .lt('intento', TON_SETTINGS.MAX_RETRIES)
      .order('created_at', { ascending: true })
      .limit(5);

    if (fetchErr) {
      logger.error(CONTEXT, 'Error fetching withdrawals', fetchErr);
      return res.status(500).json({
        ok: false,
        error: ERROR_MESSAGES.DATABASE_ERROR,
      });
    }

    if (!retiros || retiros.length === 0) {
      logger.log(CONTEXT, 'No pending withdrawals');
      return res.status(200).json({
        ok: true,
        procesados: 0,
        mensaje: 'No withdrawals to process',
      });
    }

    logger.log(CONTEXT, `📋 Processing ${retiros.length} withdrawals`);

    // Process each withdrawal
    const resultados = [];
    for (const retiro of retiros) {
      const resultado = await processWithdrawal(tonweb, adminWallet, retiro);
      resultados.push(resultado);
      await sleep(1500); // Space out transactions
    }

    const exitosos = resultados.filter((r) => r.ok).length;
    const fallidos = resultados.filter((r) => !r.ok).length;

    logger.log(CONTEXT, '✅ Cron job completed', {
      procesados: retiros.length,
      exitosos,
      fallidos,
    });

    return res.status(200).json({
      ok: true,
      procesados: retiros.length,
      exitosos,
      fallidos,
      detalle: resultados,
    });
  } catch (error) {
    logger.error(CONTEXT, 'Cron job failed', error);
    return res.status(500).json({
      ok: false,
      error: ERROR_MESSAGES.INTERNAL_ERROR,
    });
  }
};
