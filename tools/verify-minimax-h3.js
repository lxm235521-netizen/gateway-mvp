// 端到端验证 minimax-h3-2k：经网关创建视频任务并轮询到终态。
// 用法：node tools/verify-minimax-h3.js <gatewayBaseUrl> <gatewayKey> [prompt]
const axios = require('axios');

const baseUrl = process.argv[2] || 'http://154.44.9.233:3009';
const gatewayKey = process.argv[3] || 'sk-test-key-123';
const prompt = process.argv[4] || '一只纸船在平静湖面缓缓漂流，水面有轻微涟漪，晨雾，电影感，无人物';

const headers = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' };

// 顺带查一下之前意外提交的任务是否已经结束（该任务号来自上游直连探测）
const earlierTaskId = 'task_IFddsYNnIXkEJPI1rjTcknAxwhXGyzcX';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    try {
        const earlier = await axios.get(`${baseUrl}/v1/videos/${earlierTaskId}`, { headers, timeout: 60000 });
        console.log(`[早先意外提交的任务] status=${earlier.data.status} progress=${earlier.data.progress} video_url=${earlier.data.video_url || '(空)'}`);
    } catch (error) {
        console.log(`[早先意外提交的任务] 查询失败 ${error.response ? error.response.status : error.message}`);
    }

    console.log(`\n创建任务: model=minimax-h3-2k\nprompt=${prompt}`);
    let created;
    const startedAt = Date.now();
    try {
        const response = await axios.post(`${baseUrl}/v1/videos`, {
            model: 'minimax-h3-2k',
            prompt,
            seconds: '15',
            aspect_ratio: '16:9',
            resolution: '2k'
        }, { headers, timeout: 300000 });
        created = response.data;
        console.log(`创建返回: HTTP ${response.status} ${JSON.stringify(created)}`);
    } catch (error) {
        const status = error.response ? error.response.status : 'n/a';
        console.log(`创建失败: ${status} ${JSON.stringify(error.response ? error.response.data : error.message)}`);
        return;
    }

    const taskId = created.task_id || created.id;
    if (!taskId) {
        console.log('没有拿到网关任务号，无法轮询');
        return;
    }

    for (let attempt = 1; attempt <= 40; attempt += 1) {
        await sleep(15000);
        try {
            const response = await axios.get(`${baseUrl}/v1/videos/${taskId}`, { headers, timeout: 60000 });
            const body = response.data || {};
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(`#${attempt} (${elapsed}s) status=${body.status} progress=${body.progress}${body.video_url ? ` video_url=${body.video_url}` : ''}${body.error ? ` error=${JSON.stringify(body.error)}` : ''}`);
            if (body.status === 'completed' || body.status === 'failed') {
                console.log(`\n终态: ${body.status}`);
                console.log(JSON.stringify(body, null, 2).slice(0, 1200));
                return;
            }
        } catch (error) {
            console.log(`#${attempt} 轮询失败 ${error.response ? error.response.status : error.message}`);
        }
    }
    console.log('\n轮询超时（10 分钟）');
})();
