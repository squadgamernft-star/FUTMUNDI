const { supabase } = require('../utils/supabase');

const ADMIN_WALLETS = [
    'uqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7vg',
    'eqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7va'
];

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: 'Database not configured' });
    }

    const { adminWallet, targetWallet, nftIdx } = req.body || {};

    if (!adminWallet || !targetWallet || nftIdx === undefined) {
        return res.status(400).json({ ok: false, error: 'Faltan datos' });
    }

    if (!ADMIN_WALLETS.includes(adminWallet.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'No autorizado' });
    }

    try {
        // En una dApp real aquí se haría una llamada al Smart Contract para hacer el MINT del NFT.
        // Simularemos el éxito.

        // OPCIONAL: Si quisieras registrar este regalo en la base de datos de Supabase,
        // podrías hacer un INSERT a una tabla `regalos_nft`.
        
        return res.status(200).json({ ok: true, mensaje: `✅ ¡NFT ID ${nftIdx} transferido exitosamente a ${targetWallet.slice(0, 6)}...!` });
    } catch (error) {
        console.error('Error enviando NFT:', error);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
