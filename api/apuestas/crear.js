const { supabase } = require('../_utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { wallet, evento_id, prediccion, monto_usdt, txHash } = req.body || {};

    if (!wallet || !evento_id || !prediccion || !monto_usdt || !txHash) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    try {
        const { error } = await supabase
            .from('apuestas_tickets')
            .insert([{
                wallet_address: wallet,
                evento_id,
                prediccion,
                monto_usdt,
                tx_hash: txHash
            }]);

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ ok: false, error: 'Transacción ya utilizada' });
            }
            throw error;
        }

        return res.status(200).json({ ok: true, message: 'Apuesta registrada con éxito' });
    } catch (error) {
        console.error('Error creating bet:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
