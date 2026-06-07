const { supabase } = require('./_utils/supabase');

const ADMIN_WALLETS = [
    'uqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7vg',
    'eqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7va',
    '0:7db8568280ce47567b571defa6ab7c588988dc2c4cef82765409f7cd0b90d1fb'
];

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!supabase) return res.status(500).json({ ok: false, error: 'Database not configured' });

    let action, adminWallet;
    if (req.method === 'GET') {
        action = req.query.action;
        adminWallet = req.query.adminWallet;
    } else {
        action = req.body && req.body.action;
        adminWallet = req.body && req.body.adminWallet;
    }

    if (!action || !adminWallet) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    if (!ADMIN_WALLETS.includes(adminWallet.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'No autorizado' });
    }

    try {
        // ── Ver lista de usuarios ──────────────────────────────────────────
        if (action === 'usuarios') {
            const { data, error } = await supabase
                .from('usuarios')
                .select('wallet_address, ref_code, telegram_id, last_seen')
                .order('last_seen', { ascending: false })
                .limit(100);
            if (error) throw error;
            return res.status(200).json({
                ok: true,
                usuarios: data.map(u => ({
                    wallet: u.wallet_address,
                    code: u.ref_code,
                    username: u.telegram_id || '—',
                    gemas: 0
                }))
            });
        }

        // ── Buscar wallet por código FM... ────────────────────────────────
        else if (action === 'buscar-codigo') {
            const raw = req.query.code || (req.body && req.body.code) || '';
            const code = raw.replace(/cod\./i, '').trim().toUpperCase();
            if (!code) return res.status(400).json({ ok: false, error: 'Falta el codigo' });

            const { data, error } = await supabase
                .from('usuarios')
                .select('wallet_address, ref_code')
                .eq('ref_code', code)
                .maybeSingle();
            if (error) throw error;

            if (data) return res.status(200).json({ ok: true, wallet: data.wallet_address });
            return res.status(404).json({ ok: false, error: 'Codigo no encontrado. El usuario debe abrir la app primero.' });
        }

        // ── Regalar NFT → guarda en tabla regalos_nft ────────────────────
        else if (action === 'regalar-nft') {
            const body = req.body || {};
            const targetWallet = (body.targetWallet || '').toLowerCase();
            const nftIdx = body.nftIdx;

            if (!targetWallet || nftIdx === undefined || nftIdx === null) {
                return res.status(400).json({ ok: false, error: 'Faltan datos (targetWallet / nftIdx)' });
            }

            // Insertar regalo pendiente en Supabase
            const { error } = await supabase
                .from('regalos_nft')
                .insert([{
                    target_wallet: targetWallet,
                    nft_idx: parseInt(nftIdx),
                    admin_wallet: adminWallet.toLowerCase(),
                    reclamado: false
                }]);

            if (error) throw error;

            const short = targetWallet.slice(0, 8) + '...' + targetWallet.slice(-6);
            return res.status(200).json({
                ok: true,
                mensaje: `✅ Regalo guardado! El NFT #${nftIdx} aparecerá en la app de ${short} la próxima vez que la abra.`
            });
        }

        else {
            return res.status(400).json({ ok: false, error: 'Accion no valida' });
        }

    } catch (e) {
        console.error('[admin]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor: ' + e.message });
    }
};
