// api/cron-retiros.js — GET /api/cron-retiros
// Ejecuta cada 10 minutos via Vercel Cron
// Procesa retiros pendientes: Admin Wallet → Contrato TON → USDT al usuario

import { createClient } from '@supabase/supabase-js';
import TonWeb from 'tonweb';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Constantes ────────────────────────────────────────────────
const CONTRACT_WALLET  = process.env.CONTRACT_WALLET  || 'EQD3u6SffmoBUVzumsMpfG5qzfvYrASNiwW6IRPVqQmv9MIs';
const WITHDRAW_OPCODE  = process.env.TON_WITHDRAW_OPCODE || '0x946a98b6';
const TON_ENDPOINT     = 'https://toncenter.com/api/v2/jsonRPC';
const CRON_SECRET      = process.env.CRON_SECRET;
const MAX_POR_CORRIDA  = 5; // procesar máx 5 retiros por ejecución

export default async function handler(req, res) {
  // ── Autenticación del cron ────────────────────────────────
  const authHeader = req.headers['authorization'] ?? '';
  const secret = authHeader.replace('Bearer ', '').trim();

  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  // ── Inicializar TonWeb ────────────────────────────────────
  const tonweb = new TonWeb(new TonWeb.HttpProvider(TON_ENDPOINT));
  let adminWallet;

  try {
    const mnemonic = (process.env.TON_ADMIN_MNEMONIC || '').trim().split(/\s+/);
    if (mnemonic.length < 24) {
      return res.status(500).json({ ok: false, error: 'TON_ADMIN_MNEMONIC inválido (necesita 24 palabras)' });
    }
    const keyPair = await TonWeb.mnemonic.mnemonicToKeyPair(mnemonic);
    adminWallet = new tonweb.wallet.all['v4R2'](tonweb.provider, {
      publicKey: keyPair.publicKey
    });
    adminWallet._keyPair = keyPair;
  } catch (e) {
    console.error('[cron] Error inicializando wallet admin:', e);
    return res.status(500).json({ ok: false, error: 'Error al cargar wallet admin' });
  }

  // ── Leer retiros pendientes ───────────────────────────────
  const { data: retiros, error: fetchErr } = await supabase
    .from('retiros')
    .select('*')
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: true })
    .limit(MAX_POR_CORRIDA);

  if (fetchErr) {
    console.error('[cron] Error leyendo retiros:', fetchErr);
    return res.status(500).json({ ok: false, error: 'Error leyendo retiros pendientes' });
  }

  if (!retiros || retiros.length === 0) {
    return res.status(200).json({ ok: true, procesados: 0, mensaje: 'Sin retiros pendientes' });
  }

  const resultados = [];

  for (const retiro of retiros) {
    const resultado = await procesarRetiro(tonweb, adminWallet, retiro);
    resultados.push(resultado);
    // Pequeña pausa entre transacciones
    await sleep(1500);
  }

  const exitosos = resultados.filter(r => r.ok).length;
  const fallidos  = resultados.filter(r => !r.ok).length;

  console.log(`[cron] Corrida completada: ${exitosos} exitosos, ${fallidos} fallidos`);

  return res.status(200).json({
    ok: true,
    procesados: retiros.length,
    exitosos,
    fallidos,
    detalle: resultados
  });
}

// ── Procesar un retiro individual ─────────────────────────────
async function procesarRetiro(tonweb, adminWallet, retiro) {
  // Marcar como "procesando" para evitar doble ejecución
  const { error: lockErr } = await supabase
    .from('retiros')
    .update({ estado: 'procesando' })
    .eq('id', retiro.id)
    .eq('estado', 'pendiente'); // condición atómica

  if (lockErr) {
    return { id: retiro.id, ok: false, error: 'No se pudo bloquear el retiro' };
  }

  try {
    // Construir payload para el contrato:
    // opcode + destino en formato bytes + cantidad en nano-USDT
    const opcode = parseInt(WITHDRAW_OPCODE, 16);
    const usdtNano = BigInt(Math.round(retiro.usdt * 1_000_000)); // 6 decimales USDT

    const cell = new TonWeb.boc.Cell();
    cell.bits.writeUint(opcode, 32);                          // opcode 32-bit
    cell.bits.writeAddress(new TonWeb.utils.Address(retiro.destino)); // destino
    cell.bits.writeCoins(usdtNano);                           // cantidad USDT

    // Obtener seqno del admin wallet
    const seqno = await adminWallet.methods.seqno().call() ?? 0;

    // Enviar transacción al contrato
    const transfer = adminWallet.methods.transfer({
      secretKey: adminWallet._keyPair.secretKey,
      toAddress: CONTRACT_WALLET,
      amount: TonWeb.utils.toNano('0.05'), // gas TON
      seqno,
      payload: cell,
      sendMode: 3
    });

    const txResult = await transfer.send();
    const txHash = txResult?.hash
      ? Buffer.from(txResult.hash).toString('hex')
      : 'tx_' + Date.now();

    // Marcar como completado
    await supabase
      .from('retiros')
      .update({ estado: 'completado', tx_hash: txHash })
      .eq('id', retiro.id);

    console.log(`[cron] ✅ Retiro ${retiro.id} completado. tx: ${txHash}`);
    return { id: retiro.id, ok: true, txHash };

  } catch (err) {
    console.error(`[cron] ❌ Error en retiro ${retiro.id}:`, err.message);

    // Marcar como fallido y reintegrar gemas
    await supabase
      .from('retiros')
      .update({ estado: 'fallido', error_msg: err.message })
      .eq('id', retiro.id);

    // Reintegrar gemas al usuario
    await reintegrarGemas(retiro.wallet, retiro.gemas);

    return { id: retiro.id, ok: false, error: err.message };
  }
}

// Devuelve las gemas al usuario si el envío TON falla
async function reintegrarGemas(wallet, gemas) {
  try {
    const { data: perfil } = await supabase
      .from('perfiles')
      .select('gemas')
      .eq('wallet', wallet)
      .single();

    if (!perfil) return;

    await supabase
      .from('perfiles')
      .update({ gemas: Number(perfil.gemas) + Number(gemas) })
      .eq('wallet', wallet);

    console.log(`[cron] Gemas reintegradas a ${wallet}: +${gemas}`);
  } catch (e) {
    console.error('[cron] Error reintegrando gemas:', e);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
