const express = require('express');
const axios = require('axios');
const cors = require('cors');
const MongoClient = require('mongodb').MongoClient;
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = 8014;

let accessToken = process.env.ACCESS_TOKEN;
const refreshToken = process.env.REFRESH_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;


// CORS 설정
app.use(cors({ origin: '*' }));
let db; // MongoDB 데이터베이스 객체

// MongoDB 연결
async function connectMongoDB() {
    try {
        const client = new MongoClient(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        await client.connect();
        console.log('MongoDB에 성공적으로 연결되었습니다.');
        db = client.db(process.env.MONGO_DB_NAME); // 데이터베이스 선택
    } catch (error) {
        console.error('MongoDB 연결 오류:', error.message);
        process.exit(1); // 연결 실패 시 프로세스 종료
    }
}

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
        console.log('Access Token이 갱신되었습니다:', accessToken);
    } catch (error) {
        console.error('Access Token 갱신 오류:', error.response ? error.response.data : error.message);
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
            console.log('Access Token이 만료되었습니다. 갱신 시도 중...');
            await refreshAccessToken(); // Access Token 갱신
            return apiRequest(method, url, data, params); // 갱신된 토큰으로 재시도
        } else {
            console.error('API 요청 오류:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

// 판매 데이터 가져와 MongoDB에 저장하는 함수
async function fetchAndSaveSalesData() {
    const today = new Date();
    const end_date = today.toISOString().split('T')[0];
    const lastWeekStart = new Date(today.setDate(today.getDate() - 7));
    const start_date = lastWeekStart.toISOString().split('T')[0];
    const excludedProductNos = [
        1743, 1744, 1745, 1746, 1747, 1748, 1749, 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1757, 1758, 1759, 1760, 1858,
        1859, 1860, 1861, 1862, 1863, 1864, 1865, 1866, 1867, 1868, 1869, 1870, 1817, 1872, 1873, 1874, 1875, 1876, 1877,
        1878, 1879, 1880, 1881, 1882, 1883, 1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893, 2113,
    ];

    try {
        const productData = await apiRequest('GET', 'http://localhost:8014/api/products');
        const productNos = productData
            .filter((no) => !excludedProductNos.includes(no)) // 제외된 product_no 필터링
            .join(',');

        if (!productNos) {
            console.log('유효한 상품 번호가 없습니다.');
            return;
        }

        const salesData = await apiRequest(
            'GET',
            'https://yogibo.cafe24api.com/api/v2/admin/reports/salesvolume',
            {},
            {
                shop_no: 1,
                start_date,
                end_date,
                product_no: productNos,
            }
        );

        const mergedData = salesData.salesvolume.reduce((acc, current) => {
            const existing = acc.find((item) => item.product_no === current.product_no);

            if (existing) {
                existing.total_sales += parseInt(current.total_sales, 10);
                const priceSum =
                    parseInt(existing.product_price.replace(/,/g, ''), 10) +
                    parseInt(current.product_price.replace(/,/g, ''), 10);
                existing.product_price = priceSum.toLocaleString('ko-KR');
            } else {
                acc.push({
                    ...current,
                    total_sales: parseInt(current.total_sales, 10),
                    product_price: parseInt(current.product_price.replace(/,/g, ''), 10).toLocaleString('ko-KR'),
                });
            }
            return acc;
        }, []);

        const enrichedData = mergedData.map((item) => ({
            ...item,
            calculated_total_price: (
                parseInt(item.product_price.replace(/,/g, ''), 10) * item.total_sales
            ).toLocaleString('ko-KR'),
        }));

        const sortedData = enrichedData
            .sort((a, b) => parseInt(b.calculated_total_price.replace(/,/g, ''), 10) - parseInt(a.calculated_total_price.replace(/,/g, ''), 10))
            .slice(0, 6);

        const collection = db.collection('sales');
        await collection.deleteMany({}); // 기존 데이터 삭제
        await collection.insertMany(sortedData); // 새 데이터 저장

        console.log('MongoDB에 판매 데이터 저장 완료.');
    } catch (error) {
        console.error('판매 데이터를 저장하는 중 오류가 발생했습니다:', error.message);
    }
}


// MongoDB 데이터 제공 API
app.get('/api/mongo-sales', async (req, res) => {
    try {
        const collection = db.collection('sales');
        const salesData = await collection.find().toArray();
        res.json(salesData);
    } catch (error) {
        console.error('MongoDB 데이터 가져오기 오류:', error.message);
        res.status(500).send('MongoDB 데이터를 가져오는 중 오류가 발생했습니다.');
    }
});

// 매주 화요일 00:00에 데이터 갱신
//cron.schedule('0 0 * * 2', fetchAndSaveSalesData);

cron.schedule('52 14 * * *', async () => {
    console.log('테스트 Cron 작업 실행');
    await fetchAndSaveSalesData();
});
// 서버 시작 및 MongoDB 연결
app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
    await connectMongoDB(); // 서버 시작 시 MongoDB 연결 초기화
});