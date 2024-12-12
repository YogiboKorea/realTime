// 필요한 모듈 불러오기
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const mongoose = require('mongoose');
const cors = require('cors');

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

// MongoDB 연결
mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

// MongoDB 스키마 정의
const ProductSchema = new mongoose.Schema({
    product_no: Number,
    product_name: String,
    product_price: String,
    total_sales: Number,
    calculated_total_price: String,
    created_date: Date
});

const Product = mongoose.model('Product', ProductSchema);

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

// 판매 순위 기반 상품 정보 저장
app.get('/api/save-sales-rank-products', async (req, res) => {
    const { start_date, end_date, shop_no = 1 } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).send('시작 날짜와 종료 날짜는 필수입니다.');
    }

    try {
        // 판매 순위 데이터 가져오기
        const salesData = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/reports/salesvolume', {}, {
            shop_no,
            start_date,
            end_date,
        });

        if (!salesData.salesvolume.length) {
            return res.status(404).send('판매 데이터가 없습니다.');
        }

        // 판매 순위 상품 번호 가져오기
        const productNos = salesData.salesvolume.map(item => item.product_no);

        // 각 상품의 상세 정보 가져오기
        const productDetails = await Promise.all(productNos.map(async (productNo) => {
            const productData = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/products', {}, { product_no: productNo });
            return productData.products[0];
        }));

        // MongoDB에 저장
        const savedProducts = await Product.insertMany(
            productDetails.map(product => ({
                product_no: product.product_no,
                product_name: product.product_name,
                product_price: product.product_price,
                total_sales: salesData.salesvolume.find(item => item.product_no === product.product_no)?.total_sales || 0,
                calculated_total_price: (
                    parseInt(product.product_price.replace(/,/g, ''), 10) *
                    (salesData.salesvolume.find(item => item.product_no === product.product_no)?.total_sales || 0)
                ).toLocaleString('ko-KR'),
                created_date: new Date(product.created_date),
            }))
        );

        res.status(200).json({
            message: '판매 순위 기반 상품 정보가 성공적으로 저장되었습니다.',
            savedProducts
        });
    } catch (error) {
        console.error('판매 순위 상품 저장 중 오류 발생:', error.message);
        res.status(500).send('판매 순위 상품 저장 중 오류 발생');
    }
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
