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
    } else if (req.method === 'POST') {
        action = req.body && req.body.action;
        adminWallet = req.body && req.body.adminWallet;
    } else {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!action || !adminWallet) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    if (!ADMIN_WALLETS.includes(adminWallet.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'No autorizado' });
    }

    try {
        if (action === 'usuarios') {
            const { data, error } = await supabase
                .from('usuarios')
                .select('wallet_address, ref_code, telegram_id, last_seen')
                .order('last_seen', { ascending: false })
                .limit(100);
            if (error) throw error;
            const usuarios = data.map(u => ({
                wallet: u.wallet_address,
                code: u.ref_code,
                username: u.telegram_id ? u.telegram_id : '—',
                gemas: 0
            }));
            return res.status(200).json({ ok: true, usuarios });
        }

        else if (action === 'buscar-codigo') {
            const raw = req.query.code || '';
            const code = raw.replace(/cod\./i, '').trim().toUpperCase();
            if (!code) return res.status(400).json({ ok: false, error: 'Falta el codigo' });

            const { data, error } = await supabase
                .from('usuarios')
                .select('wallet_address, ref_code, telegram_id')
                .eq('ref_code', code)
                .maybeSingle();
            if (error) throw error;

            if (data) {
                return res.status(200).json({ ok: true, wallet: data.wallet_address, code: data.ref_code });
            }
            return res.status(404).json({ ok: false, error: 'Codigo no encontrado. El usuario debe abrir la app primero.' });
        }

        else if (action === 'regalar-nft') {
            const body = req.body || {};
            const targetWallet = body.targetWallet;
            const nftIdx = body.nftIdx;
            if (!targetWallet || nftIdx === undefined) {
                return res.status(400).json({ ok: false, error: 'Faltan datos' });
            }
            const short = targetWallet.slice(0, 8) + '...' + targetWallet.slice(-6);
            return res.status(200).json({ ok: true, mensaje: 'NFT #' + nftIdx + ' transferido a ' + short });
        }

        else {
            return res.status(400).json({ ok: false, error: 'Accion no valida' });
        }
    } catch (e) {
        console.error('[admin]', e.message);
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
