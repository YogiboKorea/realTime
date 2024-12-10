const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 8014;

let accessToken = process.env.ACCESS_TOKEN;
const refreshToken = process.env.REFRESH_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;

app.use(express.static('public')); // public 디렉토리에서 정적 파일 제공

// 접근 토큰
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

// 최근 등록된 상품 목록 조회 (최대 1000개)
app.get('/api/products', async (req, res) => {
    try {
        const limit = 100; // 한 번에 가져올 상품 수
        const maxProducts = 1000; // 최대 1000개 가져오기
        let offset = 0; // 페이징 시작점
        const allProducts = [];

        while (allProducts.length < maxProducts) {
            const params = {
                limit,
                offset,
                order_by: '-created_date', // 최신순 정렬
            };

            const data = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/products', {}, params);

            if (data.products.length === 0) {
                break; // 더 이상 가져올 데이터가 없으면 종료
            }

            allProducts.push(...data.products.map((product) => product.product_no));
            offset += limit; // 다음 페이지로 이동
        }

        res.json(allProducts.slice(0, maxProducts)); // 최대 1000개의 상품 번호 반환
    } catch (error) {
        res.status(500).send('상품 목록을 가져오는 중 오류가 발생했습니다.');
    }
});
// 판매 수량 통계 조회 엔드포인트
app.get('/api/sales-volume', async (req, res) => {
    const { start_date, end_date, shop_no = 1 } = req.query;

    if (!start_date || !end_date) {
        return res.status(400).send('시작 날짜와 종료 날짜는 필수입니다.');
    }

    // 제외할 product_no 설정
    const excludedProductNos = []; // 제외할 상품 번호들

    try {
        // 최근 등록된 상품 번호 목록 가져오기
        const productData = await apiRequest('GET', 'http://localhost:8014/api/products');
        const productNos = productData
            .filter(no => !excludedProductNos.includes(no)) // 제외된 product_no 필터링
            .join(',');

        if (!productNos) {
            return res.status(404).send('제외된 상품 번호를 제외한 유효한 상품 번호가 없습니다.');
        }

        // 판매 데이터 조회
        const data = await apiRequest(
            'GET',
            'https://yogibo.cafe24api.com/api/v2/admin/reports/salesvolume',
            {},
            {
                shop_no,
                start_date,
                end_date,
                product_no: productNos, // 필터링된 상품 번호들 추가
            }
        );

        // `variants_code` 기준으로 데이터 합치기
        const mergedData = data.salesvolume.reduce((acc, current) => {
            if (excludedProductNos.includes(current.product_no)) {
                return acc; // 제외된 product_no는 추가하지 않음
            }

            const existing = acc.find(item => item.product_no === current.product_no);

            if (existing) {
                // `total_sales` 합산 (정수형으로 처리)
                existing.total_sales = parseInt(existing.total_sales, 10) + parseInt(current.total_sales, 10);

                // `product_price` 합산 (원 단위로 합산)
                const priceSum = (
                    parseInt(existing.product_price.replace(/,/g, ''), 10) +
                    parseInt(current.product_price.replace(/,/g, ''), 10)
                );

                existing.product_price = priceSum.toLocaleString('ko-KR'); // 원 단위로 포맷팅
            } else {
                acc.push({
                    ...current,
                    total_sales: parseInt(current.total_sales, 10), // 정수형으로 초기화
                    product_price: parseInt(current.product_price.replace(/,/g, ''), 10).toLocaleString('ko-KR') // 초기값을 원 단위로 설정
                });
            }
            return acc;
        }, []);

        // 각 항목에 `calculated_total_price` 추가
        const enrichedData = mergedData.map(item => ({
            ...item,
            calculated_total_price: (
                parseInt(item.product_price.replace(/,/g, ''), 10) * item.total_sales
            ).toLocaleString('ko-KR') // 원 단위로 포맷팅
        }));

        // `calculated_total_price` 기준 내림차순 정렬 및 상위 6개 추출
        const top6Data = enrichedData
            .sort((a, b) => {
                const priceA = parseInt(a.calculated_total_price.replace(/,/g, ''), 10);
                const priceB = parseInt(b.calculated_total_price.replace(/,/g, ''), 10);
                return priceB - priceA; // 내림차순 정렬
            })
            .slice(0, 6); // 상위 6개만 추출

        res.json(top6Data); // 결과 반환
    } catch (error) {
        console.error('판매 수량 데이터를 가져오는 중 오류가 발생했습니다:', error.message);
        res.status(500).send('판매 수량 데이터를 가져오는 중 오류가 발생했습니다.');
    }
});

app.get('/api/products/:product_no', async (req, res) => {
    const { product_no } = req.params;

    try {
        const params = {
            product_no // 특정 상품 번호 지정
        };

        // Cafe24의 products API 호출
        const data = await apiRequest('GET', 'https://yogibo.cafe24api.com/api/v2/admin/products', {}, params);

        // 요청 결과에서 해당 상품 반환
        if (data.products.length > 0) {
            res.json(data.products[0]); // 첫 번째 상품 반환
        } else {
            res.status(404).send('상품을 찾을 수 없습니다.');
        }
    } catch (error) {
        console.error(`상품 정보를 가져오는 중 오류가 발생했습니다: ${error.message}`);
        res.status(500).send('상품 정보를 가져오는 중 오류가 발생했습니다.');
    }
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
});


/*
// 정기 Cron 작업 (매주 화요일 00:00)
cron.schedule('0 0 * * 2', fetchAndSaveSalesData);
*/