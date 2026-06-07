const { supabase } = require('../utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { wallet, requiredReferrals } = req.body || {};

    if (!wallet) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    try {
        // Verificar cuántos referidos NO reclamados tiene este usuario
        const { data, error: fetchError } = await supabase
            .from('referidos')
            .select('id')
            .eq('referrer_wallet', wallet)
            .eq('reclamado', false);

        if (fetchError) throw fetchError;

        if (data.length < requiredReferrals) {
            return res.status(400).json({ ok: false, error: `No tienes suficientes referidos (tienes ${data.length}, necesitas ${requiredReferrals})` });
        }

        // Marcar los primeros N referidos como reclamados
        const idsToClaim = data.slice(0, requiredReferrals).map(r => r.id);
        
        const { error: updateError } = await supabase
            .from('referidos')
            .update({ reclamado: true })
            .in('id', idsToClaim);

        if (updateError) throw updateError;

        // Aquí se procedería a la transferencia automática del NFT (mint) vía contrato inteligente
        // Dado que es un entorno sin claves privadas de billetera maestra, simulamos el éxito.

        return res.status(200).json({ ok: true, message: 'NFT reclamado con éxito (Simulado)' });
    } catch (error) {
        console.error('Error claiming NFT:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
