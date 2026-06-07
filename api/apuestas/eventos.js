const { supabase } = require('../_utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    try {
        const { data, error } = await supabase
            .from('apuestas_eventos')
            .select('*')
            .eq('estado', 'abierto')
            .order('fecha', { ascending: true });

        if (error) throw error;

        return res.status(200).json({ ok: true, eventos: data });
    } catch (error) {
        console.error('Error fetching eventos:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
