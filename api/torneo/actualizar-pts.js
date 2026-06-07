const { supabase } = require('../utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { wallet, pts } = req.body || {};

    if (!wallet || pts === undefined) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    try {
        // Obtener los puntos actuales
        const { data: current, error: fetchError } = await supabase
            .from('torneo_inscripciones')
            .select('puntos')
            .eq('wallet_address', wallet)
            .single();

        if (fetchError || !current) {
            return res.status(404).json({ ok: false, error: 'Usuario no inscrito en torneo' });
        }

        // Actualizar sumando los nuevos puntos
        const { error: updateError } = await supabase
            .from('torneo_inscripciones')
            .update({ puntos: current.puntos + Number(pts) })
            .eq('wallet_address', wallet);

        if (updateError) throw updateError;

        return res.status(200).json({ ok: true, message: 'Puntos actualizados' });
    } catch (error) {
        console.error('Error updating points:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
