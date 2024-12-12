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

let accessToken = process.env.ACCESS_TOKEN;
const refreshToken = process.env.REFRESH_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoUri = process.env.MONGO_URI; // MongoDB URI
const dbName = process.env.DB_NAME; // MongoDB Database Name
const collectionName = process.env.COLLECTION_NAME; // MongoDB Collection Name

app.use(cors());
app.use(express.json());

// Access Token 갱신 함수
async function refreshAccessToken() {
    try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const response = await axios.post(
            'https://yogibo.cafe24api.com/api/v2/oauth/token',
            `grant_type=refresh_token&refresh_token=${refreshToken}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`
                }
            }
        );
        accessToken = response.data.access_token;
        console.log('Access Token 갱신 성공:', accessToken);
    } catch (error) {
        console.error('Access Token 갱신 실패:', error.response ? error.response.data : error.message);
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
            }
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
        const limit = 100;
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

// 서버 실행 시 자동 실행 함수
async function initializeServer() {
    const now = moment().tz('Asia/Seoul');
    const start_date = now.clone().subtract(7, 'days').format('YYYY-MM-DD 00:00:00');
    const end_date = now.format('YYYY-MM-DD 23:59:59');

    let client;

    try {
        console.log(`데이터 수집 및 저장 시작: ${start_date} ~ ${end_date}`);

        // 제외할 상품 번호 설정
        const excludedProductNos = [2128]; // 제외할 상품 번호 입력

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

        // `calculated_total_price` 기준 내림차순 정렬 및 상위 6개 추출
        const top6Data = mergedData
            .map(item => ({
                ...item,
                calculated_total_price: parseInt(item.product_price.replace(/,/g, ''), 10) * item.total_sales,
            }))
            .sort((a, b) => b.calculated_total_price - a.calculated_total_price)
            .slice(0, 6);

        console.log('상위 6개 데이터:', top6Data);

        // MongoDB에 저장
        client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        // 이전 데이터 삭제
        await collection.deleteMany({});

        // 새 데이터 삽입
        for (const item of top6Data) {
            const productData = await apiRequest('GET', `https://yogibo.cafe24api.com/api/v2/admin/products`, {}, { product_no: item.product_no });

            if (productData.products && productData.products.length > 0) {
                const product = productData.products[0];

                await collection.insertOne({
                    ...product,
                    calculated_total_price: item.calculated_total_price,
                });

                console.log(`상품 번호 ${product.product_no} 데이터 저장 완료`);
            } else {
                console.error(`상품 번호 ${item.product_no} 데이터를 찾을 수 없습니다.`);
            }
        }

        console.log('상위 6개 상품 데이터가 성공적으로 저장되었습니다.');
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

    // 10분 단위 스케줄링
    schedule.scheduleJob('*/10 * * * *', async () => {
        console.log('스케줄 작업 실행: 데이터 초기화 시작');
        await initializeServer();
        console.log('스케줄 작업 완료: 데이터 초기화 완료');
    });

    await initializeServer();
});
