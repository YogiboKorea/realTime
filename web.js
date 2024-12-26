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

// 최근 등록된 상품 번호 가져오기
async function getRecentProducts(excludedProductNos = []) {
    try {
        const limit = 40;
        const maxProducts = 1000;
        let offset = 0;
        const allProducts = [];

        while (allProducts.length < maxProducts) {
            const params = { limit, offset, order_by: '-created_date' };
            const data = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/products', {}, params);

            if (data.products.length === 0) break;

            allProducts.push(...data.products.map(product => product.product_no));
            offset += limit;
        }

        const filteredProducts = allProducts.filter(productNo => !excludedProductNos.includes(productNo));

        console.log('가져온 상품 번호 (제외 후):', filteredProducts);
        return filteredProducts;
    } catch (error) {
        console.error('최근 상품 데이터를 가져오는 중 오류 발생:', error.message);
        throw error;
    }
}

// 순위 변동 비교 함수
async function compareRankings(newRankings) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(rankingCollectionName);

        const previousRankings = await collection.find({}).toArray();

        const updatedRankings = newRankings.map((item, index) => {
            const previousRank = previousRankings.find(r => r.product_no === item.product_no);
            if (!previousRank) {
                return { ...item, rankChange: 'new' };
            } else {
                const rankDifference = previousRank.rank - (index + 1);
                return rankDifference > 0
                    ? { ...item, rankChange: `+${rankDifference}` }
                    : { ...item, rankChange: null };
            }
        });

        await collection.deleteMany({});
        await collection.insertMany(updatedRankings);

        console.log('순위 비교 및 저장 완료:', updatedRankings);
        return updatedRankings;
    } finally {
        await client.close();
    }
}

// 서버 실행 시 자동 실행 함수
async function initializeServer() {
    const now = moment().tz('Asia/Seoul');
    const start_date = now.clone().subtract(3, 'days').format('YYYY-MM-DD 00:00:00');
    const end_date = now.format('YYYY-MM-DD 23:59:59');

    let client;

    try {
        console.log(`데이터 수집 및 저장 시작: ${start_date} ~ ${end_date}`);

        // 제외할 상품 번호 설정
        const excludedProductNos = [1593, 1594, 1595, 1596, 1597]; // 제외할 상품 번호 입력

        // 최근 등록된 상품 번호 가져오기
        const productNos = await getRecentProducts(excludedProductNos);

        if (!productNos || productNos.length === 0) {
            console.error('유효한 상품 번호가 없습니다.');
            return;
        }

        console.log('상품 번호:', productNos);

        // 판매 데이터 조회
        const salesData = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/reports/salesvolume', {}, {
            shop_no: 1,
            start_date,
            end_date,
            product_no: productNos.join(','),
        });

        console.log('판매 데이터:', salesData.salesvolume);

        if (!salesData.salesvolume || salesData.salesvolume.length === 0) {
            console.error('판매 데이터가 없습니다.');
            return;
        }

        // 동일한 product_no 합산
        const mergedData = salesData.salesvolume.reduce((acc, current) => {
            const existing = acc.find(item => item.product_no === current.product_no);

            if (existing) {
                existing.total_sales += current.total_sales;
                existing.product_price = parseInt(existing.product_price.replace(/,/g, ''), 10) +
                                         parseInt(current.product_price.replace(/,/g, ''), 10);
                existing.product_price = existing.product_price.toLocaleString('ko-KR');
            } else {
                acc.push({
                    ...current,
                    total_sales: parseInt(current.total_sales, 10),
                    product_price: parseInt(current.product_price.replace(/,/g, ''), 10).toLocaleString('ko-KR')
                });
            }
            return acc;
        }, []);

        // `calculated_total_price` 기준 내림차순 정렬 및 상위 14개 추출
        const top14Data = mergedData
            .map((item, index) => ({
                ...item,
                rank: index + 1,
                calculated_total_price: parseInt(item.product_price.replace(/,/g, ''), 10) * item.total_sales,
            }))
            .sort((a, b) => b.calculated_total_price - a.calculated_total_price)
            .slice(0, 20);

        console.log('상위 14개 데이터:', top14Data);

        // 순위 변동 비교 및 MongoDB 저장
        const updatedRankings = await compareRankings(top14Data);

        // MongoDB에 저장
        client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        // 이전 데이터 삭제
        await collection.deleteMany({});

        // 새 데이터 삽입
        for (const item of updatedRankings) {
            const productData = await apiRequest('GET', `https://yogibo.cafe24api.com/api/v2/admin/products`, {}, { product_no: item.product_no });

            if (productData.products && productData.products.length > 0) {
                const product = productData.products[0];

                await collection.insertOne({
                    ...product,
                    calculated_total_price: item.calculated_total_price,
                    rankChange: item.rankChange,
                });

                console.log(`상품 번호 ${product.product_no} 데이터 저장 완료`);
            } else {
                console.error(`상품 번호 ${item.product_no} 데이터를 찾을 수 없습니다.`);
            }
        }

        console.log('상위 14개 상품 데이터가 성공적으로 저장되었습니다.');
    } catch (error) {
        console.error('서버 초기화 중 오류 발생:', error.message);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

app.get('/api/products', async (req, res) => {
    let client;

    try {
        client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        // MongoDB에서 저장된 데이터 가져오기
        const products = await collection.find({}).toArray();

        // 반환
        res.json(products);
    } catch (error) {
        console.error('MongoDB에서 데이터를 가져오는 중 오류 발생:', error.message);
        res.status(500).send('데이터를 가져오는 중 오류가 발생했습니다.');
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// 서버 시작
app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);

    // MongoDB에서 최신 토큰 가져오기
    await getTokensFromDB();

    // 3일 간격 00시 스케줄링
    schedule.scheduleJob('0 0 */1 * *', async () => {
        console.log('스케줄 작업 실행: 데이터 초기화 시작');
        await initializeServer();
        console.log('스케줄 작업 완료: 데이터 초기화 완료');
    });

    await initializeServer();
});

