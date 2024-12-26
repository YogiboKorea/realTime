// 필요한 모듈 불러오기
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { MongoClient } = require('mongodb');
const cors = require('cors');
const moment = require('moment-timezone');
const schedule = require('node-schedule');

const app = express();
const PORT = 8014;

let accessToken = 'NXeIs5MfZkilGhNn5ndKeX';
let refreshToken = 'f5iOoMkTGakL7gyQOZyRqD';

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoUri = process.env.MONGO_URI; // MongoDB URI
const dbName = process.env.DB_NAME; // MongoDB Database Name
const collectionName = process.env.COLLECTION_NAME; // MongoDB Collection Name
const tokenCollectionName = 'tokens'; // MongoDB Token Collection Name
const rankingCollectionName = 'rankings'; // MongoDB Collection for Rankings

app.use(cors());
app.use(express.json());

// MongoDB에서 토큰 읽기
async function getTokensFromDB() {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(tokenCollectionName);

        const tokens = await collection.findOne({ name: 'cafe24Tokens' });
        if (tokens) {
            accessToken = tokens.accessToken;
            refreshToken = tokens.refreshToken;
            console.log('MongoDB에서 토큰 로드 성공:', tokens);
        } else {
            console.log('MongoDB에 저장된 토큰이 없습니다. 초기값 사용');
        }
    } finally {
        await client.close();
    }
}

// MongoDB에 토큰 저장
async function saveTokensToDB(newAccessToken, newRefreshToken) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(tokenCollectionName);

        await collection.updateOne(
            { name: 'cafe24Tokens' },
            {
                $set: {
                    name: 'cafe24Tokens',
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken,
                    updatedAt: new Date(),
                },
            },
            { upsert: true } // 데이터가 없으면 새로 생성
        );
        console.log('MongoDB에 토큰 저장 완료');
    } finally {
        await client.close();
    }
}

// Access Token 및 Refresh Token 갱신 함수
async function refreshAccessToken() {
    try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const response = await axios.post(
            'https://yogibo.cafe24api.com/api/v2/oauth/token',
            `grant_type=refresh_token&refresh_token=${refreshToken}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                },
            }
        );

        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;

        console.log('Access Token 갱신 성공:', newAccessToken);
        console.log('Refresh Token 갱신 성공:', newRefreshToken);

        // 갱신된 토큰을 저장
        await saveTokensToDB(newAccessToken, newRefreshToken);

        // 메모리에 갱신
        accessToken = newAccessToken;
        refreshToken = newRefreshToken;

        return newAccessToken;
    } catch (error) {
        if (error.response?.data?.error === 'invalid_grant') {
            console.error('Refresh Token이 만료되었습니다. 인증 단계를 다시 수행해야 합니다.');
        } else {
            console.error('Access Token 갱신 실패:', error.response ? error.response.data : error.message);
        }
        throw error;
    }
}


// API 요청 함수
async function apiRequest(method, url, data = {}, params = {}) {
    try {
        const response = await axios({
            method,
            url,
            data,
            params,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        return response.data;
    } catch (error) {
        if (error.response?.status === 401) {
            console.log('Access Token 만료. 갱신 중...');
            await refreshAccessToken();
            return apiRequest(method, url, data, params);
        } else {
            console.error('API 요청 오류:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}


// MongoDB에서 기존 상품 순위 가져오기
async function getPreviousRankings() {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(rankingCollectionName);

        const previousRankings = await collection.find({}).toArray();
        return previousRankings;
    } finally {
        await client.close();
    }
}

// MongoDB에 새 순위 저장
async function saveRankingsToDB(updatedRankings) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(rankingCollectionName);

        await collection.deleteMany({});
        await collection.insertMany(updatedRankings);

        console.log('순위 데이터 저장 완료');
    } finally {
        await client.close();
    }
}

// API 요청 함수
async function apiRequest(method, url, data = {}, params = {}) {
    try {
        const response = await axios({
            method,
            url,
            data,
            params,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        return response.data;
    } catch (error) {
        if (error.response?.status === 401) {
            console.log('Access Token 만료. 갱신 중...');
            await refreshAccessToken();
            return apiRequest(method, url, data, params);
        } else {
            console.error('API 요청 오류:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

// 순위 변동 비교 함수
async function calculateRankChanges(newRankings) {
    const previousRankings = await getPreviousRankings();

    const updatedRankings = newRankings.map((item, index) => {
        const previousItem = previousRankings.find(r => r.product_no === item.product_no);
        const newRank = index + 1;

        if (!previousItem) {
            return { ...item, rankChange: 'new', rank: newRank };
        } else if (newRank <= 8) {
            const rankDifference = previousItem.rank - newRank;
            return {
                ...item,
                rankChange: rankDifference > 0 ? `+${rankDifference}` : null,
                rank: newRank,
            };
        } else {
            return { ...item, rankChange: null, rank: newRank };
        }
    });

    return updatedRankings;
}

// 서버 실행 시 자동 실행 함수
async function initializeServer() {
    const now = moment().tz('Asia/Seoul');
    const start_date = now.clone().subtract(3, 'days').format('YYYY-MM-DD 00:00:00');
    const end_date = now.format('YYYY-MM-DD 23:59:59');

    try {
        console.log(`데이터 수집 및 저장 시작: ${start_date} ~ ${end_date}`);

        // 판매 데이터 조회
        const salesData = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/reports/salesvolume', {}, {
            shop_no: 1,
            start_date,
            end_date,
        });

        const newRankings = salesData.salesvolume
            .map(item => ({
                product_no: item.product_no,
                total_sales: item.total_sales,
                calculated_total_price: parseInt(item.product_price.replace(/,/g, ''), 10) * item.total_sales,
            }))
            .sort((a, b) => b.calculated_total_price - a.calculated_total_price)
            .slice(0, 20);

        const updatedRankings = await calculateRankChanges(newRankings);

        await saveRankingsToDB(updatedRankings);

        console.log('순위 변동 처리 완료');
    } catch (error) {
        console.error('서버 초기화 중 오류 발생:', error.message);
    }
}

// API Endpoint to Get Rankings
app.get('/api/products', async (req, res) => {
    try {
        const rankings = await getPreviousRankings();
        res.json(rankings);
    } catch (error) {
        console.error('MongoDB에서 데이터를 가져오는 중 오류 발생:', error.message);
        res.status(500).send('데이터를 가져오는 중 오류가 발생했습니다.');
    }
});

// 서버 시작
app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);

    schedule.scheduleJob('0 0 */3 * *', async () => {
        console.log('스케줄 작업 실행: 데이터 초기화 시작');
        await initializeServer();
        console.log('스케줄 작업 완료: 데이터 초기화 완료');
    });

    await initializeServer();
});