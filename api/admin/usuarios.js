const { supabase } = require('../utils/supabase');

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

    const adminWallet = req.query.adminWallet;

    if (!adminWallet || !ADMIN_WALLETS.includes(adminWallet.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'No autorizado' });
    }

    try {
        // En este ejemplo, cargamos usuarios desde torneo_inscripciones
        const { data, error } = await supabase
            .from('torneo_inscripciones')
            .select('wallet_address, puntos')
            .order('puntos', { ascending: false })
            .limit(50);

        if (error) throw error;

        const usuarios = data.map(u => ({
            wallet: u.wallet_address,
            username: '—', // El username se gestionaría desde un bot de telegram, pero enviamos '—'
            gemas: u.puntos
        }));

        return res.status(200).json({ ok: true, usuarios });
    } catch (error) {
        console.error('Error fetching admin users:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
