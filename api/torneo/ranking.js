const { supabase } = require('../_utils/supabase');

module.exports = async (req, res) => {
    // Solo permitir GET
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    try {
        // Obtener ranking ordenado por fecha de inscripción (o puntos si se implementara un sistema de puntuación)
        const { data, error } = await supabase
            .from('torneo_inscripciones')
            .select('wallet_address, puntos, created_at')
            .order('created_at', { ascending: true });

        if (error) throw error;

        return res.status(200).json({ ok: true, ranking: data });
    } catch (error) {
        console.error('Error fetching ranking:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
