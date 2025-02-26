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

let accessToken = 'FPgfiY4jICtB9LihPieotD';
let refreshToken = 'PI5HCvg1CNskfQ4FsW4hjH';

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoUri = process.env.MONGO_URI;         // MongoDB URI
const dbName = process.env.DB_NAME;             // MongoDB Database Name
const collectionName = process.env.COLLECTION_NAME; // MongoDB Collection Name (상품 데이터 저장)
const tokenCollectionName = 'tokens';           // MongoDB Token Collection Name
const rankingCollectionName = 'rankings';       // MongoDB 순위 Collection Name
const MALLID = 'yogibo';              // 예: "yourmallid"
const CATEGORY_NO = process.env.CATEGORY_NO || 858; // 카테고리 번호 (예: 858)

app.use(cors());
app.use(express.json())

// --- 토큰 관리 관련 함수 ---

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
            console.log('MongoDB에 저장된 토큰이 없습니다. 초기값 사용 데이터 추가');
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
            { upsert: true }
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
            `https://${MALLID}.cafe24api.com/api/v2/oauth/token`,
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
        await saveTokensToDB(newAccessToken, newRefreshToken);
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

// --- 카테고리 상품 및 판매 데이터 관련 함수 ---

// 1. 카테고리 상품 목록 조회
async function getCategoryProducts(category_no) {
    const url = `https://${MALLID}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const params = { display_group: 1 };
    try {
        const data = await apiRequest('GET', url, {}, params);
        console.log(`카테고리 ${category_no}의 상품 수:`, data.products.length);
        return data.products;
    } catch (error) {
        console.error('카테고리 상품 조회 오류:', error.message);
        throw error;
    }
}

// 2. 특정 상품들의 판매 데이터 조회
async function getSalesDataForProducts(productNos, start_date, end_date) {
    const url = `https://${MALLID}.cafe24api.com/api/v2/admin/reports/salesvolume`;
    const params = {
        shop_no: 1,
        start_date,
        end_date,
        product_no: productNos.join(','),
    };
    try {
        const data = await apiRequest('GET', url, {}, params);
        console.log('판매 데이터 조회 완료:', data.salesvolume.length);
        return data.salesvolume;
    } catch (error) {
        console.error('판매 데이터 조회 오류:', error.message);
        throw error;
    }
}

// 3. 판매 순위 계산 및 정렬
function calculateAndSortRanking(categoryProducts, salesData) {
    // 카테고리 상품의 product_no 목록 생성
    const productNosSet = new Set(categoryProducts.map(p => p.product_no));
    // 판매 데이터 중 해당 카테고리 상품에 해당하는 데이터만 필터링
    const filteredSales = salesData.filter(item => productNosSet.has(item.product_no));
    
    // 동일 상품번호의 데이터 합산 (판매 수량, 판매 금액)
    const mergedData = filteredSales.reduce((acc, curr) => {
        // 기존 데이터가 있다면 합산
        const existing = acc.find(item => item.product_no === curr.product_no);
        // product_price를 숫자로 처리 (문자열일 경우 replace 후 파싱, 숫자일 경우 그대로 사용)
        const currPrice = typeof curr.product_price === 'string' 
                          ? parseInt(curr.product_price.replace(/,/g, ''), 10)
                          : curr.product_price;
        if (existing) {
            existing.total_sales += parseInt(curr.total_sales, 10);
            // 기존 product_price가 숫자형이므로 그대로 합산
            existing.product_price += currPrice;
        } else {
            acc.push({
                ...curr,
                total_sales: parseInt(curr.total_sales, 10),
                product_price: currPrice
            });
        }
        return acc;
    }, []);
    
    // 각 상품별 계산된 총 판매 금액 (판매금액 * 판매수량)
    const rankedData = mergedData.map(item => ({
        ...item,
        calculated_total_price: item.product_price * item.total_sales
    }));
    
    // 내림차순 정렬 및 순위 번호 부여
    rankedData.sort((a, b) => b.calculated_total_price - a.calculated_total_price);
    rankedData.forEach((item, index) => {
        item.rank = index + 1;
    });
    
    return rankedData;
}

// --- 순위 변동 비교 함수 (기존 코드 유지) ---
async function compareRankings(newRankings) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(rankingCollectionName);
        const previousRankings = await collection.find({}).toArray();
        const updatedRankings = newRankings.map((item, index) => {
            const previousItem = previousRankings.find(r => r.product_no === item.product_no);
            const newRank = index + 1;
            if (!previousItem) {
                return { ...item, rankChange: 'new', rank: newRank };
            }
            if (newRank <= 8) {
                const rankDifference = previousItem.rank - newRank;
                return {
                    ...item,
                    rankChange: rankDifference > 0 ? `▲${rankDifference}` : null,
                    rank: newRank,
                };
            }
            return { ...item, rankChange: null, rank: newRank };
        });
        await collection.deleteMany({});
        await collection.insertMany(updatedRankings);
        console.log('순위 비교 및 저장 완료:', updatedRankings);
        return updatedRankings;
    } finally {
        await client.close();
    }
}

// --- 전체 플로우: 카테고리 기반 판매 순위 처리 및 DB 저장 ---
async function initializeServer() {
    const now = moment().tz('Asia/Seoul');
    const start_date = now.clone().subtract(3, 'days').format('YYYY-MM-DD 00:00:00');
    const end_date = now.format('YYYY-MM-DD 23:59:59');

    let client;
    try {
        console.log(`데이터 수집 및 저장 시작: ${start_date} ~ ${end_date}`);

        // 1. 카테고리 상품 조회
        const categoryProducts = await getCategoryProducts(CATEGORY_NO);
        if (!categoryProducts || categoryProducts.length === 0) {
            console.error('해당 카테고리에는 상품이 없습니다.');
            return;
        }
        const productNos = categoryProducts.map(p => p.product_no);
        console.log('카테고리 상품 번호:', productNos);

        // 2. 판매 데이터 조회
        const salesData = await getSalesDataForProducts(productNos, start_date, end_date);
        if (!salesData || salesData.length === 0) {
            console.error('판매 데이터가 없습니다.');
            return;
        }

        // 3. 판매 순위 계산 및 정렬
        const rankedData = calculateAndSortRanking(categoryProducts, salesData);
        console.log('계산된 순위 데이터:', rankedData);

        // 4. 순위 변동 비교 및 DB 저장 (rankingCollectionName)
        const updatedRankings = await compareRankings(rankedData);

        // 5. 상품 상세정보 조회 후 최종 결과 DB 저장 (collectionName)
        client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        await collection.deleteMany({});

        for (const item of updatedRankings) {
            const productData = await apiRequest(
                'GET',
                `https://${MALLID}.cafe24api.com/api/v2/admin/products`,
                {},
                { product_no: item.product_no }
            );
            if (productData.products && productData.products.length > 0) {
                const product = productData.products[0];
                await collection.insertOne({
                    ...product,
                    calculated_total_price: item.calculated_total_price,
                    rankChange: item.rankChange,
                    rank: item.rank,
                });
                console.log(`상품 번호 ${product.product_no} 데이터 저장 완료`);
            } else {
                console.error(`상품 번호 ${item.product_no} 데이터를 찾을 수 없습니다.`);
            }
        }
        console.log('카테고리 기반 상위 상품 데이터가 성공적으로 저장되었습니다.');
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
        const products = await collection.find({}).toArray();
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

// 서버 시작 및 스케줄 등록
app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    await getTokensFromDB();
    // 스케줄: 매일 00시 실행 (원하는 주기로 수정 가능)
    schedule.scheduleJob('0 0 * * *', async () => {
        console.log('스케줄 작업 실행: 토큰 갱신 시작');
        try {
            await refreshAccessToken();
            console.log('토큰 갱신 완료');
        } catch (error) {
            console.error('토큰 갱신 중 오류 발생:', error.message);
        }
    });
    await initializeServer();
});
