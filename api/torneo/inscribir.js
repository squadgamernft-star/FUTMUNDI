const { supabase } = require('../utils/supabase');

module.exports = async (req, res) => {
    // Solo permitir POST
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { wallet, txHash } = req.body || {};

    if (!wallet || !txHash) {
        return res.status(400).json({ ok: false, error: 'Faltan datos (wallet o txHash)' });
    }

    try {
        // En una aplicación de producción real, aquí deberías verificar que txHash (el BOC)
        // se propagó a la blockchain y que el pago de USDT llegó a tu contrato.
        // Dado el entorno actual, lo guardaremos directamente.
        
        const { error } = await supabase
            .from('torneo_inscripciones')
            .insert([{ wallet_address: wallet, tx_hash: txHash }]);

        if (error) {
            if (error.code === '23505') { // Unique violation
                return res.status(400).json({ ok: false, error: 'Esta transacción ya fue utilizada o ya estás inscrito' });
            }
            throw error;
        }

        return res.status(200).json({ ok: true, message: 'Inscripción exitosa' });
    } catch (error) {
        console.error('Error inscribiendo:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
