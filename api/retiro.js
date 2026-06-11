// api/retiro.js — POST /api/retiro
// Verifica saldo, registra retiro pendiente, descuenta gemas

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MIN_GEMAS  = 160;
const MAX_GEMAS  = 3000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { wallet, destino, gemas, usdt } = req.body ?? {};

  // ── Validaciones básicas ──────────────────────────────────────
  if (!wallet || !destino || !gemas || !usdt) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  if (!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(destino)) {
    return res.status(400).json({ ok: false, error: 'Dirección TON inválida (debe empezar con EQ o UQ)' });
  }

  const gemasNum = Number(gemas);
  const usdtNum  = Number(usdt);

  if (isNaN(gemasNum) || gemasNum < MIN_GEMAS || gemasNum > MAX_GEMAS) {
    return res.status(400).json({ ok: false, error: `Gemas deben estar entre ${MIN_GEMAS} y ${MAX_GEMAS}` });
  }

  if (isNaN(usdtNum) || usdtNum <= 0) {
    return res.status(400).json({ ok: false, error: 'Monto USDT inválido' });
  }

  // ── Leer perfil del usuario ───────────────────────────────────
  const { data: perfil, error: perfilErr } = await supabase
    .from('perfiles')
    .select('gemas')
    .eq('wallet', wallet)
    .single();

  if (perfilErr || !perfil) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  }

  if (perfil.gemas < gemasNum) {
    return res.status(400).json({ ok: false, error: 'Saldo insuficiente de gemas' });
  }

  // ── Transacción: descontar gemas + insertar retiro ────────────
  const gemasRestantes = Number((perfil.gemas - gemasNum).toFixed(2));

  // 1. Insertar retiro en estado pendiente
  const { data: retiro, error: retiroErr } = await supabase
    .from('retiros')
    .insert({
      wallet,
      destino,
      gemas: gemasNum,
      usdt: usdtNum,
      estado: 'pendiente'
    })
    .select('id')
    .single();

  if (retiroErr) {
    console.error('[retiro] Error al insertar:', retiroErr);
    return res.status(500).json({ ok: false, error: 'Error al registrar el retiro' });
  }

  // 2. Descontar gemas del perfil
  const { error: updateErr } = await supabase
    .from('perfiles')
    .update({ gemas: gemasRestantes })
    .eq('wallet', wallet);

  if (updateErr) {
    // Rollback: borrar el retiro recién insertado
    await supabase.from('retiros').delete().eq('id', retiro.id);
    console.error('[retiro] Error al descontar gemas:', updateErr);
    return res.status(500).json({ ok: false, error: 'Error al actualizar saldo' });
  }

  // 3. Comisión referidos (5%)
  acreditarComisionReferido(wallet, gemasNum).catch(e =>
    console.error('[retiro] Error comisión referido:', e)
  );

  return res.status(200).json({
    ok: true,
    retiroId: retiro.id,
    gemasRestantes
  });
}

// Acredita 5% de gemas al referidor (si existe)
async function acreditarComisionReferido(wallet, gemas) {
  const { data: perfil } = await supabase
    .from('perfiles')
    .select('referido_by')
    .eq('wallet', wallet)
    .single();

  if (!perfil?.referido_by) return;

  const comision = Number((gemas * 0.05).toFixed(2));

  // Sumar comisión al referidor
  await supabase.rpc('incrementar_gemas', {
    p_wallet: perfil.referido_by,
    p_cantidad: comision
  });

  // Registrar en tabla referidos
  await supabase
    .from('referidos')
    .update({ comision_gemas: supabase.raw('comision_gemas + ' + comision) })
    .match({ referidor: perfil.referido_by, referido: wallet });
}
