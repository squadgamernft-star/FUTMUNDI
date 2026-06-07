const { supabase } = require('../_utils/supabase');

// Reclama todos los regalos NFT pendientes del admin para esta wallet
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (!supabase) return res.status(500).json({ ok: false, error: 'Database not configured' });

    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ ok: false, error: 'Falta wallet' });

    const walletLower = wallet.toLowerCase();

    try {
        // Buscar regalos pendientes
        const { data: regalos, error: fetchErr } = await supabase
            .from('regalos_nft')
            .select('id, nft_idx')
            .eq('target_wallet', walletLower)
            .eq('reclamado', false);

        if (fetchErr) throw fetchErr;

        if (!regalos || regalos.length === 0) {
            return res.status(400).json({ ok: false, error: 'No tienes regalos pendientes' });
        }

        // Marcar como reclamados
        const ids = regalos.map(r => r.id);
        const { error: updateErr } = await supabase
            .from('regalos_nft')
            .update({ reclamado: true })
            .in('id', ids);

        if (updateErr) throw updateErr;

        const nfts = regalos.map(r => r.nft_idx);
        const nombres = nfts.map(idx => `NFT #${idx}`).join(', ');

        return res.status(200).json({
            ok: true,
            nfts,
            mensaje: `🎁 ¡Recibiste: ${nombres}! Ya aparecen en tu colección.`
        });

    } catch (e) {
        console.error('[reclamar-nft]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
