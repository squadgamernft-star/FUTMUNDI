const { supabase } = require('./_utils/supabase');

// Endpoint unificado de registro:
// POST con { type: 'usuario', wallet, refCode, telegramId }  --> registra usuario
// POST con { type: 'referido', referrerWallet, newWallet }   --> registra referido

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const body = req.body || {};
    const type = body.type || 'usuario';

    try {
        // ── Registrar usuario (wallet connect) ──────────────────────────────
        if (type === 'usuario') {
            const { wallet, refCode, telegramId } = body;
            if (!wallet || !refCode) return res.status(400).json({ ok: false, error: 'Faltan datos' });

            const { error } = await supabase
                .from('usuarios')
                .upsert({
                    wallet_address: wallet.toLowerCase(),
                    ref_code: refCode.toUpperCase(),
                    telegram_id: telegramId || null,
                    last_seen: new Date().toISOString()
                }, { onConflict: 'wallet_address' });

            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        // ── Registrar referido ───────────────────────────────────────────────
        else if (type === 'referido') {
            const { referrerWallet, newWallet } = body;
            if (!referrerWallet || !newWallet || referrerWallet === newWallet) {
                return res.status(400).json({ ok: false, error: 'Datos invalidos' });
            }

            const { error } = await supabase
                .from('referidos')
                .insert([{ referrer_wallet: referrerWallet, referred_wallet: newWallet }]);

            if (error) {
                if (error.code === '23505') {
                    return res.status(400).json({ ok: false, error: 'El usuario ya fue referido por alguien mas' });
                }
                throw error;
            }
            return res.status(200).json({ ok: true, message: 'Referido registrado' });
        }

        else {
            return res.status(400).json({ ok: false, error: 'Tipo no valido' });
        }
    } catch (e) {
        console.error('[registrar]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
