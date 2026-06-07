const { supabase } = require('../utils/supabase');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { referrerWallet, newWallet } = req.body || {};

    if (!referrerWallet || !newWallet || referrerWallet === newWallet) {
        return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    try {
        const { error } = await supabase
            .from('referidos')
            .insert([{
                referrer_wallet: referrerWallet,
                referred_wallet: newWallet
            }]);

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ ok: false, error: 'El usuario ya fue referido por alguien más' });
            }
            throw error;
        }

        return res.status(200).json({ ok: true, message: 'Referido registrado' });
    } catch (error) {
        console.error('Error registering referral:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
