// api/retiro.js — POST /api/retiro
// Verifica saldo, registra retiro pendiente, descuenta gemas
// VERSIÓN MEJORADA CON VALIDACIONES ROBUSTAS

import { createClient } from '@supabase/supabase-js';
import TonWeb from 'tonweb';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MIN_GEMAS  = 160;
const MAX_GEMAS  = 3000;
const MIN_USDT   = 0.1;
const MAX_USDT   = 500;
const USDT_RATIO = 100; // 100 gemas = 1 USDT

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { wallet, destino, gemas, usdt, captcha } = req.body ?? {};

  // ── Validaciones básicas ──────────────────────────────────────
  if (!wallet || !destino || !gemas || !usdt) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  // ✅ MEJORADO: Validar dirección TON correctamente con TonWeb
  let destinoAddress;
  try {
    destinoAddress = new TonWeb.utils.Address(destino);
    // Verificar que sea una dirección válida
    if (!destinoAddress || destinoAddress.toString().length === 0) {
      throw new Error('Inválida');
    }
  } catch (e) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Dirección TON inválida. Debe ser una dirección estándar (EQ o UQ)' 
    });
  }

  // ✅ NUEVO: Verificar captcha si está habilitado
  if (captcha && process.env.HCAPTCHA_SECRET) {
    const captchaValid = await verificarCaptcha(captcha);
    if (!captchaValid) {
      return res.status(400).json({ ok: false, error: 'Captcha inválido o expirado' });
    }
  }

  const gemasNum = Number(gemas);
  const usdtNum  = Number(usdt);

  // ✅ MEJORADO: Validación más estricta
  if (isNaN(gemasNum) || !Number.isInteger(gemasNum) || gemasNum < MIN_GEMAS || gemasNum > MAX_GEMAS) {
    return res.status(400).json({ 
      ok: false, 
      error: `Gemas deben ser un número entero entre ${MIN_GEMAS} y ${MAX_GEMAS}` 
    });
  }

  if (isNaN(usdtNum) || usdtNum < MIN_USDT || usdtNum > MAX_USDT) {
    return res.status(400).json({ 
      ok: false, 
      error: `Monto USDT debe estar entre ${MIN_USDT} y ${MAX_USDT}` 
    });
  }

  // ── Verificar ratio gemas/USDT ────────────────────────────────
  const ratioEsperado = gemasNum / USDT_RATIO;
  if (Math.abs(usdtNum - ratioEsperado) > 0.02) {
    return res.status(400).json({ 
      ok: false, 
      error: `Ratio incorrecto. ${gemasNum} gemas = ${ratioEsperado.toFixed(2)} USDT aproximadamente` 
    });
  }

  // ── Leer perfil del usuario ───────────────────────────────────
  const { data: perfil, error: perfilErr } = await supabase
    .from('perfiles')
    .select('gemas, wallet_verificada, ultimo_retiro')
    .eq('wallet', wallet)
    .single();

  if (perfilErr || !perfil) {
    return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  }

  // ✅ NUEVO: Verificar wallet antes de permitir retiro
  if (!perfil.wallet_verificada) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Debes conectar tu wallet en TON Connect antes de retirar' 
    });
  }

  if (perfil.gemas < gemasNum) {
    return res.status(400).json({ 
      ok: false, 
      error: `Saldo insuficiente. Tienes ${perfil.gemas.toFixed(2)} gemas, necesitas ${gemasNum}` 
    });
  }

  // ✅ NUEVO: Validar cooldown entre retiros (5 minutos)
  if (perfil.ultimo_retiro) {
    const ultimoRetiro = new Date(perfil.ultimo_retiro);
    const ahora = new Date();
    const minutosTranscurridos = (ahora - ultimoRetiro) / (1000 * 60);
    
    if (minutosTranscurridos < 5) {
      return res.status(400).json({ 
        ok: false, 
        error: `Debes esperar ${Math.ceil(5 - minutosTranscurridos)} minutos antes de solicitar otro retiro` 
      });
    }
  }

  // ── Transacción: descontar gemas + insertar retiro ────────────
  const gemasRestantes = Number((perfil.gemas - gemasNum).toFixed(2));

  // 1. Insertar retiro en estado pendiente
  const { data: retiro, error: retiroErr } = await supabase
    .from('retiros')
    .insert({
      wallet,
      destino: destinoAddress.toString(),
      gemas: gemasNum,
      usdt: usdtNum,
      estado: 'pendiente',
      intento: 0,
      created_at: new Date().toISOString(),
      metadata: {
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        user_agent: req.headers['user-agent'] || 'unknown'
      }
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
    .update({ 
      gemas: gemasRestantes,
      ultimo_retiro: new Date().toISOString()
    })
    .eq('wallet', wallet);

  if (updateErr) {
    // ✅ MEJORADO: Rollback con manejo de errores
    try {
      await supabase.from('retiros').delete().eq('id', retiro.id);
    } catch (e) {
      console.error('[retiro] Error en rollback:', e);
    }
    console.error('[retiro] Error al descontar gemas:', updateErr);
    return res.status(500).json({ ok: false, error: 'Error al actualizar saldo' });
  }

  // 3. Comisión referidos (5%) - async sin bloquear
  acreditarComisionReferido(wallet, gemasNum).catch(e =>
    console.error('[retiro] Error comisión referido:', e)
  );

  return res.status(200).json({
    ok: true,
    retiroId: retiro.id,
    gemasRestantes,
    usdt: usdtNum,
    mensaje: 'Retiro en procesamiento. Se completará en 5-15 minutos',
    estado: 'pendiente'
  });
}

// ✅ NUEVO: Verificar captcha hCaptcha
async function verificarCaptcha(token) {
  try {
    const response = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `response=${token}&secret=${process.env.HCAPTCHA_SECRET}`
    });
    const data = await response.json();
    return data.success === true;
  } catch (e) {
    console.error('[retiro] Error verificando captcha:', e);
    return false;
  }
}

// Acredita 5% de gemas al referidor (si existe)
async function acreditarComisionReferido(wallet, gemas) {
  try {
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

    console.log(`[retiro] Comisión ${comision} gemas acreditada a ${perfil.referido_by}`);
  } catch (e) {
    console.error('[retiro] Error acreditando comisión:', e);
  }
}
