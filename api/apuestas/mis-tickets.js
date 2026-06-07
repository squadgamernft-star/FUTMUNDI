const { supabase } = require('../_utils/supabase');

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
            .from('apuestas_tickets')
            .select(`
                id, prediccion, monto_usdt, cobrado,
                evento:apuestas_eventos ( id, equipo_a, equipo_b, estado, resultado_a, resultado_b )
            `)
            .eq('wallet_address', wallet)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Formatear la respuesta para el frontend
        const tickets = data.map(t => ({
            id: t.id,
            evento_id: t.evento.id,
            equipo_a: t.evento.equipo_a,
            equipo_b: t.evento.equipo_b,
            prediccion: t.prediccion,
            monto_usdt: t.monto_usdt,
            estado_evento: t.evento.estado,
            cobrado: t.cobrado,
            es_ganador: evaluarGanador(t.prediccion, t.evento.resultado_a, t.evento.resultado_b)
        }));

        return res.status(200).json({ ok: true, tickets });
    } catch (error) {
        console.error('Error fetching tickets:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};

function evaluarGanador(prediccion, res_a, res_b) {
    if (res_a === null || res_b === null) return false;
    if (prediccion === 'local' && res_a > res_b) return true;
    if (prediccion === 'visitante' && res_b > res_a) return true;
    if (prediccion === 'empate' && res_a === res_b) return true;
    return false;
}
