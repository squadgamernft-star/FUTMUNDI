const { supabase } = require('./_utils/supabase');

// Endpoint unificado:
// POST { wallet, ... }             → retorna perfil + regalos pendientes (y registra usuario)
// POST { type:'referido', ... }    → registra relación de referido

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (!supabase) return res.status(500).json({ ok: false, error: 'Database not configured' });

    const body = req.body || {};

    // ── Registrar referido ────────────────────────────────────────────────
    if (body.type === 'referido') {
        const { referrerWallet, newWallet } = body;
        if (!referrerWallet || !newWallet || referrerWallet === newWallet) {
            return res.status(400).json({ ok: false, error: 'Datos invalidos' });
        }
        try {
            const { error } = await supabase
                .from('referidos')
                .insert([{ referrer_wallet: referrerWallet.toLowerCase(), referred_wallet: newWallet.toLowerCase() }]);
            if (error) {
                if (error.code === '23505') return res.status(400).json({ ok: false, error: 'Ya referido' });
                throw error;
            }
            return res.status(200).json({ ok: true });
        } catch (e) {
            console.error('[perfil/referido]', e.message);
            return res.status(500).json({ ok: false, error: 'Error del servidor' });
        }
    }

    // ── Perfil de usuario (registra + retorna datos) ──────────────────────
    const { wallet, telegramId, telegramUsername } = body;
    if (!wallet) return res.status(400).json({ ok: false, error: 'Falta wallet' });

    const walletLower = wallet.toLowerCase();
    const code = generateCode(wallet);

    try {
        // Upsert: registra o actualiza el usuario
        await supabase.from('usuarios').upsert({
            wallet_address: walletLower,
            ref_code: code,
            telegram_id: telegramUsername || telegramId || null,
            last_seen: new Date().toISOString()
        }, { onConflict: 'wallet_address' });

        // Puntos del torneo
        const { data: torneoData } = await supabase
            .from('torneo_inscripciones')
            .select('puntos')
            .eq('wallet_address', walletLower)
            .maybeSingle();

        // Regalos NFT pendientes del admin
        const { data: regalos } = await supabase
            .from('regalos_nft')
            .select('id, nft_idx')
            .eq('target_wallet', walletLower)
            .eq('reclamado', false);

        const tieneRegaloPendiente = !!(regalos && regalos.length > 0);
        const nftsPendientes = tieneRegaloPendiente ? regalos.map(r => ({ id: r.id, idx: r.nft_idx })) : [];

        return res.status(200).json({
            ok: true,
            usuario: {
                gemas: torneoData ? torneoData.puntos : 0,
                nfts: [],
                tieneRegaloPendiente,
                nftsPendientes,
                referralCode: code
            }
        });

    } catch (e) {
        console.error('[perfil]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};

function generateCode(wallet) {
    if (!wallet || wallet === 'guest') return 'FMXXXXXX';
    let hash = 0;
    for (let i = 0; i < wallet.length; i++) {
        const c = wallet.charCodeAt(i);
        hash = ((hash << 5) - hash) + c;
        hash = hash & hash;
    }
    return 'FM' + Math.abs(hash).toString(36).toUpperCase().slice(0, 6).padStart(6, 'X');
}
