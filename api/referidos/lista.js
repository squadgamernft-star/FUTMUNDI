const { supabase } = require('../_utils/supabase');

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

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const wallet = req.query.wallet;
    if (!wallet) {
        return res.status(400).json({ ok: false, error: 'Falta wallet' });
    }

    const refCode = generateCode(wallet).toLowerCase();

    try {
        const { data, error } = await supabase
            .from('referidos')
            .select('referred_wallet, reclamado, created_at')
            .or(`referrer_wallet.eq.${wallet.toLowerCase()},referrer_wallet.eq.${refCode}`)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Formatear para el frontend
        const referidos = data.map(r => ({
            wallet: r.referred_wallet,
            fecha: r.created_at,
            reclamado: r.reclamado,
            bonusGemas: 0
        }));

        const totalBonus = 0; // Defaulting to 0 since bonusGemas are currently 0

        return res.status(200).json({ ok: true, referidos, totalBonus });
    } catch (error) {
        console.error('Error fetching referidos:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
