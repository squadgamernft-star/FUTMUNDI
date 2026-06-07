const { supabase } = require('../utils/supabase');

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

    try {
        const { data, error } = await supabase
            .from('referidos')
            .select('referred_wallet, reclamado, created_at')
            .eq('referrer_wallet', wallet)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Formatear para el frontend
        const referidos = data.map(r => ({
            wallet: r.referred_wallet,
            fecha: r.created_at,
            reclamado: r.reclamado
        }));

        return res.status(200).json({ ok: true, referidos });
    } catch (error) {
        console.error('Error fetching referidos:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
