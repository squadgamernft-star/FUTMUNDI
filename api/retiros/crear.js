const { supabase } = require('../_utils/supabase');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (!supabase) return res.status(500).json({ ok: false, error: 'Database not configured' });

    const { wallet, destino, gemas, usdt } = req.body || {};
    if (!wallet || !destino || !gemas || !usdt) {
        return res.status(400).json({ ok: false, error: 'Datos incompletos' });
    }

    try {
        const { error } = await supabase
            .from('retiros')
            .insert([{
                wallet_address: wallet.toLowerCase(),
                wallet_destino: destino,
                cantidad_gemas: gemas,
                usdt_neto: usdt,
                estado: 'pendiente'
            }]);

        if (error) throw error;
        
        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[retiros/crear]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
