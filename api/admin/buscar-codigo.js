const { supabase } = require('../utils/supabase');

function generateDeterministicCode(wallet) {
    if (!wallet || wallet === 'guest') return 'guest';
    let hash = 0;
    for (let i = 0; i < wallet.length; i++) {
        const char = wallet.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const base36 = Math.abs(hash).toString(36).toUpperCase();
    return 'FM' + base36.slice(0, 6).padStart(6, 'X');
}

const ADMIN_WALLETS = [
    'uqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7vg',
    'eqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7va'
];

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { code, adminWallet } = req.query;

    if (!code || !adminWallet) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    if (!ADMIN_WALLETS.includes(adminWallet.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'No autorizado' });
    }

    try {
        // Buscar todas las wallets inscritas (asumimos que todos los usuarios juegan al menos el torneo)
        const { data, error } = await supabase
            .from('torneo_inscripciones')
            .select('wallet_address');

        if (error) throw error;

        const cleanCode = code.replace('cod.', '').trim().toUpperCase();

        for (let row of data) {
            const hash = generateDeterministicCode(row.wallet_address);
            if (hash === cleanCode) {
                return res.status(200).json({ ok: true, wallet: row.wallet_address });
            }
        }

        // Si no lo encuentra en torneo, buscamos en referidos
        const { data: refData, error: refError } = await supabase
            .from('referidos')
            .select('referrer_wallet, referred_wallet');
            
        if (!refError && refData) {
            for (let row of refData) {
                if (generateDeterministicCode(row.referrer_wallet) === cleanCode) {
                    return res.status(200).json({ ok: true, wallet: row.referrer_wallet });
                }
                if (generateDeterministicCode(row.referred_wallet) === cleanCode) {
                    return res.status(200).json({ ok: true, wallet: row.referred_wallet });
                }
            }
        }

        return res.status(404).json({ ok: false, error: 'Código no encontrado en la base de datos' });
    } catch (error) {
        console.error('Error buscando código:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
