// api/cron-retiros.js — GET /api/cron-retiros
// Ejecuta cada 10 minutos via Vercel Cron
// Procesa retiros pendientes: Admin Wallet → Contrato TON → USDT al usuario
// VERSIÓN MEJORADA: Gas aumentado, BigInt correcto, timeouts, reintentos

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
const MAX_POR_CORRIDA  = 5;
const MAX_INTENTOS     = 3;
const TIMEOUT_TX       = 30000; // 30 segundos
const GAS_TON_AMOUNT   = TonWeb.utils.toNano('0.15'); // ✅ MEJORADO: 0.15 TON
const USDT_DECIMALS    = 6;

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
    
    console.log('[cron] ✅ Wallet admin inicializada:', adminWallet.address);
  } catch (e) {
    console.error('[cron] Error inicializando wallet admin:', e);
    return res.status(500).json({ ok: false, error: 'Error al cargar wallet admin' });
  }

  // ── Leer retiros pendientes ───────────────────────────────
  const { data: retiros, error: fetchErr } = await supabase
    .from('retiros')
    .select('*')
    .eq('estado', 'pendiente')
    .lt('intento', MAX_INTENTOS)
    .order('created_at', { ascending: true })
    .limit(MAX_POR_CORRIDA);

  if (fetchErr) {
    console.error('[cron] Error leyendo retiros:', fetchErr);
    return res.status(500).json({ ok: false, error: 'Error leyendo retiros pendientes' });
  }

  if (!retiros || retiros.length === 0) {
    return res.status(200).json({ ok: true, procesados: 0, mensaje: 'Sin retiros pendientes' });
  }

  console.log(`[cron] 📋 Procesando ${retiros.length} retiros pendientes...`);

  const resultados = [];

  for (const retiro of retiros) {
    const resultado = await procesarRetiro(tonweb, adminWallet, retiro);
    resultados.push(resultado);
    // Pequeña pausa entre transacciones
    await sleep(1500);
  }

  const exitosos = resultados.filter(r => r.ok).length;
  const fallidos  = resultados.filter(r => !r.ok).length;

  console.log(`[cron] ✅ Corrida completada: ${exitosos} exitosos, ${fallidos} fallidos`);

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
  // ✅ NUEVO: Timeout de 30 segundos
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Timeout: transacción excedió 30s'));
    }, TIMEOUT_TX);
  });

  try {
    // Marcar como "procesando" para evitar doble ejecución
    // ✅ MEJORADO: Incluir validación de intentos
    const { error: lockErr, data: updated } = await supabase
      .from('retiros')
      .update({ 
        estado: 'procesando',
        intento: (retiro.intento || 0) + 1,
        ultimo_intento: new Date().toISOString()
      })
      .eq('id', retiro.id)
      .eq('estado', 'pendiente')
      .lt('intento', MAX_INTENTOS)
      .select('intento')
      .single();

    if (lockErr || !updated) {
      return { id: retiro.id, ok: false, error: 'No se pudo bloquear el retiro o máximo de intentos alcanzado' };
    }

    // ✅ MEJORADO: Usar Promise.race para implementar timeout
    await Promise.race([
      procesarRetiroInterno(tonweb, adminWallet, retiro),
      timeoutPromise
    ]);

    clearTimeout(timeoutHandle);

    // Marcar como completado
    await supabase
      .from('retiros')
      .update({ 
        estado: 'completado',
        completado_en: new Date().toISOString()
      })
      .eq('id', retiro.id);

    console.log(`[cron] ✅ Retiro ${retiro.id} completado`);
    return { id: retiro.id, ok: true };

  } catch (err) {
    clearTimeout(timeoutHandle);
    console.error(`[cron] ❌ Error en retiro ${retiro.id}:`, err.message);

    // ✅ MEJORADO: Verificar si es último intento
    const intentoActual = (retiro.intento || 0) + 1;
    const esUltimoIntento = intentoActual >= MAX_INTENTOS;

    await supabase
      .from('retiros')
      .update({ 
        estado: esUltimoIntento ? 'fallido' : 'pendiente',
        error_msg: err.message,
        fallido_en: esUltimoIntento ? new Date().toISOString() : null
      })
      .eq('id', retiro.id);

    // Reintegrar gemas solo si es el último intento
    if (esUltimoIntento) {
      await reintegrarGemas(retiro.wallet, retiro.gemas);
      console.log(`[cron] 🔄 Gemas reintegradas a ${retiro.wallet} (último intento fallido)`);
    }

    return { id: retiro.id, ok: false, error: err.message, intento: intentoActual };
  }
}

// ✅ NUEVO: Función interna para procesar la transacción
async function procesarRetiroInterno(tonweb, adminWallet, retiro) {
  try {
    // ✅ MEJORADO: Conversión correcta con BigInt desde el inicio
    const usdtNano = BigInt(Math.floor(retiro.usdt * Math.pow(10, USDT_DECIMALS)));
    
    // Validar que la conversión sea correcta
    if (usdtNano <= 0n) {
      throw new Error(`Monto USDT inválido: ${retiro.usdt}`);
    }

    // ✅ MEJORADO: Usar número directo en lugar de string
    const opcode = 0x946a98b6;

    const cell = new TonWeb.boc.Cell();
    cell.bits.writeUint(opcode, 32);
    cell.bits.writeAddress(new TonWeb.utils.Address(retiro.destino));
    cell.bits.writeCoins(usdtNano);

    // Obtener seqno del admin wallet
    const seqno = await adminWallet.methods.seqno().call() ?? 0;

    // ✅ MEJORADO: Enviar transacción al contrato con gas aumentado
    const transfer = adminWallet.methods.transfer({
      secretKey: adminWallet._keyPair.secretKey,
      toAddress: CONTRACT_WALLET,
      amount: GAS_TON_AMOUNT, // 0.15 TON
      seqno,
      payload: cell,
      sendMode: 3
    });

    const txResult = await transfer.send();
    
    // ✅ MEJORADO: Validar resultado de transacción
    if (!txResult || !txResult.hash) {
      throw new Error('No se recibió hash de transacción del nodo');
    }

    const txHash = Buffer.from(txResult.hash).toString('hex');

    // Guardar hash en DB
    await supabase
      .from('retiros')
      .update({ 
        tx_hash: txHash,
        enviado_en: new Date().toISOString()
      })
      .eq('id', retiro.id);

    console.log(`[cron] 🔗 Retiro ${retiro.id} enviado. Hash: ${txHash.substring(0, 16)}...`);
    
  } catch (err) {
    throw new Error(`Transacción TON fallida: ${err.message}`);
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

    if (!perfil) {
      console.error(`[cron] Error: perfil no encontrado para ${wallet}`);
      return;
    }

    const gemasActuales = Number(perfil.gemas || 0);
    const gemasNuevas = gemasActuales + Number(gemas);

    await supabase
      .from('perfiles')
      .update({ gemas: gemasNuevas })
      .eq('wallet', wallet);

    console.log(`[cron] ✅ Gemas reintegradas a ${wallet}: +${gemas} (total: ${gemasNuevas})`);
  } catch (e) {
    console.error('[cron] Error reintegrando gemas:', e);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
