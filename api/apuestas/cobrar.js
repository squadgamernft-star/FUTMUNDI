const { supabase } = require('../_utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { wallet, ticketId } = req.body || {};

    if (!wallet || !ticketId) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    try {
        // En un entorno de producción, aquí verificarías que el usuario realmente ganó
        // el ticket consultando el evento y comprobando que no ha sido cobrado ya.
        // Además, realizarías una transferencia saliente de USDT desde la billetera master
        // hacia la billetera del usuario.
        
        // Simulación: Marcar como cobrado en la base de datos
        const { error } = await supabase
            .from('apuestas_tickets')
            .update({ cobrado: true })
            .eq('id', ticketId)
            .eq('wallet_address', wallet)
            .eq('cobrado', false);

        if (error) throw error;

        return res.status(200).json({ ok: true, message: 'Recompensa de apuesta enviada (Simulada)' });
    } catch (error) {
        console.error('Error claiming bet:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
