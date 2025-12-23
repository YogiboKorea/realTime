// --- 1. 필요한 모듈 불러오기 ---
const express = require('express');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb'); // ObjectId 추가
const cors = require('cors');
const moment = require('moment-timezone');
const schedule = require('node-schedule');
const multer = require('multer');
const ftp = require('ftp');
const crypto = require('crypto');
require('dotenv').config();
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');


// --- 2. Express 앱 및 포트 설정 ---
const app = express();
const PORT = 8014; // 8014 포트로 통일

// --- 3. 전역 변수 및 .env 설정 ---

// Cafe24 API 및 랭킹 관련
let accessToken = 'B6sxr1WrHxujGvWbteE2JB'; // 초기값
let refreshToken = 'G9lX36tyIB8ne6WvVGLgjB'; // 초기값

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME;
const collectionName = process.env.COLLECTION_NAME; // 랭킹 상품 데이터
const tokenCollectionName = 'tokens';
const rankingCollectionName = 'rankings';
const MALLID = 'yogibo';
const CATEGORY_NO = process.env.CATEGORY_NO || 858;

// MongoDB 클라이언트 (전역)
const mongoClient = new MongoClient(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});
let db; // 전역 DB 객체

// FTP 및 Multer 관련
const ftpConfig = {
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
};
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const ftpClient = new ftp();

// --- 4. 미들웨어 설정 ---
app.use(express.json({ limit: '50mb' })); // 용량 제한 설정
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({
    origin: '*', // CORS 설정
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
}));

// --- 5. FTP 업로드 함수 ---
const uploadToFTP = (fileBuffer, remotePath) => {
    return new Promise((resolve, reject) => {
        const client = new ftp(); // 새 클라이언트 인스턴스 생성
        client.on('ready', () => {
            console.log('FTP 연결 성공');
            client.put(fileBuffer, remotePath, (err) => {
                if (err) {
                    console.error('FTP 업로드 오류:', err);
                    reject('FTP 업로드 오류: ' + err.message);
                } else {
                    console.log('FTP 업로드 성공:', remotePath);
                    resolve('FTP 업로드 성공');
                }
                client.end();
            });
        });
        client.on('error', (err) => {
            console.error('FTP 연결 오류:', err);
            reject('FTP 연결 오류: ' + err.message);
        });
        client.on('close', (hadError) => {
            if (hadError) console.error('FTP 비정상적 종료');
            // console.log('FTP 연결 종료');
        });
        client.connect(ftpConfig);
    });
};


// --- 6. Cafe24 API 및 랭킹 관련 함수 (MongoDB 리팩터링) ---

// MongoDB에서 토큰 읽기 (전역 db 사용)
async function getTokensFromDB() {
    try {
        const collection = db.collection(tokenCollectionName);
        const tokens = await collection.findOne({ name: 'cafe24Tokens' });
        if (tokens) {
            accessToken = tokens.accessToken;
            refreshToken = tokens.refreshToken;
            console.log('MongoDB에서 토큰 로드 성공');
        } else {
            console.log('MongoDB에 저장된 토큰이 없습니다. 초기값 사용.');
        }
    } catch (error) {
        console.error('getTokensFromDB 오류:', error);
    }
}

// MongoDB에 토큰 저장 (전역 db 사용)
async function saveTokensToDB(newAccessToken, newRefreshToken) {
    try {
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
    } catch (error) {
        console.error('saveTokensToDB 오류:', error);
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
        console.log('Access Token 갱신 성공');
        await saveTokensToDB(newAccessToken, newRefreshToken);
        accessToken = newAccessToken; // 전역 변수 업데이트
        refreshToken = newRefreshToken; // 전역 변수 업데이트
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

// API 요청 함수 (토큰 만료 시 자동 갱신)
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
            await refreshAccessToken(); // 갱신
            return apiRequest(method, url, data, params); // 재시도
        } else {
            console.error('API 요청 오류:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

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
    const productNosSet = new Set(categoryProducts.map(p => p.product_no));
    const filteredSales = salesData.filter(item => productNosSet.has(item.product_no));
    
    const mergedData = filteredSales.reduce((acc, curr) => {
        const existing = acc.find(item => item.product_no === curr.product_no);
        const currPrice = typeof curr.product_price === 'string' 
                            ? parseInt(curr.product_price.replace(/,/g, ''), 10)
                            : curr.product_price;
        if (existing) {
            existing.total_sales += parseInt(curr.total_sales, 10);
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
    
    const rankedData = mergedData.map(item => ({
        ...item,
        calculated_total_price: item.product_price * item.total_sales
    }));
    
    rankedData.sort((a, b) => b.calculated_total_price - a.calculated_total_price);
    rankedData.forEach((item, index) => {
        item.rank = index + 1;
    });
    
    return rankedData;
}

// 4. 순위 변동 비교 함수 (전역 db 사용)
async function compareRankings(newRankings) {
    try {
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
        console.log('순위 비교 및 저장 완료');
        return updatedRankings;
    } catch (error) {
        console.error('compareRankings 오류:', error);
        throw error;
    }
}

// 5. 전체 플로우: 카테고리 기반 판매 순위 처리 및 DB 저장 (전역 db 사용)
async function initializeServer() {
    const now = moment().tz('Asia/Seoul');
    const start_date = now.clone().subtract(3, 'days').format('YYYY-MM-DD 00:00:00');
    const end_date = now.format('YYYY-MM-DD 23:59:59');

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
        console.log('계산된 순위 데이터:', rankedData.length, '개');

        // 4. 순위 변동 비교 및 DB 저장 (rankingCollectionName)
        const updatedRankings = await compareRankings(rankedData);

        // 5. 상품 상세정보 조회 후 최종 결과 DB 저장 (collectionName)
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
    }
}

// --- 7. API 라우트 (엔드포인트) 정의 ---

// --- 랭킹 서버 라우트 (File 1) ---
app.get('/api/products', async (req, res) => {
    try {
        const collection = db.collection(collectionName); // 전역 db 사용
        const products = await collection.find({}).toArray();
        res.json(products);
    } catch (error) {
        console.error('MongoDB에서 랭킹 데이터를 가져오는 중 오류 발생:', error.message);
        res.status(500).send('데이터를 가져오는 중 오류가 발생했습니다.');
    }
});

// --- 이미지/캡처 서버 라우트 (File 2) ---
app.post('/save-product', upload.single('image'), async (req, res) => {
    try {
        const products = JSON.parse(req.body.products);
        const imageFile = req.file;

        if (!imageFile) {
            throw new Error('이미지 파일이 없습니다.');
        }

        const randomString = crypto.randomBytes(16).toString('hex');
        const fileExtension = imageFile.originalname.split('.').pop();
        const remotePath = `/web/img/sns/${Date.now()}.${fileExtension}`;

        const existingDocument = await db.collection('products').findOne({ imagePath: { $regex: randomString } });

        try {
            await uploadToFTP(imageFile.buffer, remotePath);
        } catch (ftpErr) {
            console.error('FTP 오류:', ftpErr);
            return res.status(500).json({ success: false, message: ftpErr });
        }

        if (existingDocument) {
            await db.collection('products').updateOne(
                { _id: existingDocument._id },
                { $push: { products: { $each: products } } }
            );
            res.json({ success: true, message: '기존 이미지에 제품이 추가되었습니다.' });
        } else {
            const newDocument = {
                imagePath: remotePath,
                products,
            };
            const result = await db.collection('products').insertOne(newDocument);
            res.json({ success: true, documentId: result.insertedId });
        }
    } catch (err) {
        console.error('상품 저장 오류:', err);
        res.status(500).json({ success: false, message: '상품 저장 오류' });
    }
});

app.get('/get-products', async (req, res) => {
    const { limit = 12, skip = 0 } = req.query;
    try {
        const products = await db.collection('products')
            .find()
            .sort({ _id: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .toArray();
        res.json({ success: true, products });
    } catch (err) {
        console.error('상품 불러오기 오류:', err);
        res.status(500).json({ success: false, message: '상품 불러오기 오류' });
    }
});

app.get('/get-big-image', async (req, res) => {
    try {
        const bigImage = await db.collection('big_images').findOne({}, { sort: { createdAt: -1 } });

        if (bigImage) {
            res.json({ success: true, imagePath: bigImage.imagePath, products: bigImage.products });
        } else {
            res.json({ success: false, message: '큰 화면 이미지가 존재하지 않습니다.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: '큰화면 이미지 불러오기 오류', error: err.message });
    }
});

app.post('/save-big-image', upload.single('image'), async (req, res) => {
    try {
        console.log('파일 업로드 요청 수신');
        const imageFile = req.file;
        if (!imageFile) {
            console.error('이미지 파일이 없습니다.');
            return res.status(400).json({ success: false, message: '이미지 파일이 없습니다.' });
        }

        const randomString = crypto.randomBytes(16).toString('hex');
        const fileExtension = imageFile.originalname.split('.').pop();
        const remotePath = `/web/img/sns/big/${Date.now()}_${randomString}.${fileExtension}`;

        console.log('FTP 업로드 경로:', remotePath);

        await uploadToFTP(imageFile.buffer, remotePath);
        console.log('FTP 업로드 성공');

        const existingBigImage = await db.collection('big_images').findOne({});
        if (existingBigImage) {
            console.log('기존 큰화면 이미지 업데이트');
            await db.collection('big_images').updateOne(
                { _id: existingBigImage._id },
                { $set: { imagePath: remotePath, updatedAt: new Date() } }
            );
        } else {
            console.log('새로운 큰화면 이미지 추가');
            await db.collection('big_images').insertOne({
                imagePath: remotePath,
                createdAt: new Date(),
            });
        }

        res.json({ success: true, imagePath: remotePath });
    } catch (err) {
        console.error('큰화면 이미지 저장 오류:', err);
        res.status(500).json({ success: false, message: '큰화면 이미지 저장 오류' });
    }
});

app.delete('/delete-product/:id', async (req, res) => {
    const productId = req.params.id;
    try {
        const result = await db.collection('products').deleteOne({ _id: new ObjectId(productId) });
        if (result.deletedCount === 1) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '삭제 실패' });
        }
    } catch (err) {
        console.error('상품 삭제 오류:', err);
        res.status(500).json({ success: false, message: '상품 삭제 오류' });
    }
});

app.post('/upload-capture', async (req, res) => {
    try {
        const { image, memberId } = req.body;

        if (!image) {
            console.error('요청 데이터 누락: image');
            return res.status(400).json({ success: false, message: '요청 데이터 누락: image가 없습니다.' });
        }

        const memberIdentifier = memberId || "null";
        const base64Data = image.replace(/^data:image\/png;base64,/, "");
        const fileBuffer = Buffer.from(base64Data, 'base64');

        const remotePath = `/web/img/captures/${memberIdentifier}_${new Date().toLocaleString("ko-KR", {
            timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).replace(/[^0-9]/g, "")}.png`;

        await uploadToFTP(fileBuffer, remotePath);

        const captureData = {
            imagePath: remotePath,
            createdAt: new Date(),
            memberId: memberIdentifier,
            likes: 0,
            likedBy: [],
        };

        const result = await db.collection('captures').insertOne(captureData);
        res.json({ success: true, imagePath: remotePath, documentId: result.insertedId });
    } catch (err) {
        console.error('캡처 업로드 처리 오류:', err);
        res.status(500).json({ success: false, message: '캡처 업로드 처리 오류' });
    }
});

app.post('/upload-capture/kakao', async (req, res) => {
    try {
        const { image, memberId } = req.body;

        if (!image) {
            console.error('요청 데이터 누락: image');
            return res.status(400).json({ success: false, message: '요청 데이터 누락: image가 없습니다.' });
        }

        const memberIdentifier = memberId || "null";
        const base64Data = image.replace(/^data:image\/png;base64,/, "");
        const fileBuffer = Buffer.from(base64Data, 'base64');

        const remotePath = `/web/img/captures/kakao/${memberIdentifier}_${new Date().toLocaleString("ko-KR", {
            timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).replace(/[^0-9]/g, "")}.png`;

        await uploadToFTP(fileBuffer, remotePath);

        const captureData = {
            imagePath: remotePath,
            createdAt: new Date(),
            memberId: memberIdentifier,
            likes: 0,
            likedBy: [],
        };

        const result = await db.collection('kakaoCapture').insertOne(captureData);
        res.json({ success: true, imagePath: remotePath, documentId: result.insertedId });
    } catch (err) {
        console.error('캡처 업로드 처리 오류:', err);
        res.status(500).json({ success: false, message: '캡처 업로드 처리 오류' });
    }
});

app.get('/get-latest-capture/kakao', async (req, res) => {
    try {
        const latestCapture = await db.collection('kakaoCapture').findOne({}, { sort: { createdAt: -1 } });
        if (latestCapture) {
            res.json({ success: true, imagePath: latestCapture.imagePath });
        } else {
            res.json({ success: false, message: '캡처된 이미지가 없습니다.' });
        }
    } catch (err) {
        console.error('최신 캡처 조회 오류:', err);
        res.status(500).json({ success: false, message: '최신 캡처 조회 오류' });
    }
});

app.get('/get-captures', async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;
        const captures = await db.collection('captures')
            .find()
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .toArray();

        res.json({ success: true, captures });
    } catch (err) {
        console.error('캡처 조회 오류:', err);
        res.status(500).json({ success: false, message: '캡처 조회 오류' });
    }
});

app.get('/get-latest-capture', async (req, res) => {
    try {
        const latestCapture = await db.collection('captures').findOne({}, { sort: { createdAt: -1 } });
        if (latestCapture) {
            res.json({ success: true, imagePath: latestCapture.imagePath });
        } else {
            res.json({ success: false, message: '캡처된 이미지가 없습니다.' });
        }
    } catch (err) {
        console.error('최신 캡처 조회 오류:', err);
        res.status(500).json({ success: false, message: '최신 캡처 조회 오류' });
    }
});

app.get('/get-images', async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;
        const images = await db.collection('captures')
            .find()
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .toArray();

        res.json({ success: true, images });
    } catch (err) {
        console.error('이미지 데이터 불러오기 오류:', err);
        res.status(500).json({ success: false, message: '이미지 데이터를 불러오는 중 오류가 발생했습니다.' });
    }
});

app.post('/like-image', async (req, res) => {
    try {
        const { imageId, memberId } = req.body;

        if (!imageId || !memberId) {
            return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
        }

        const image = await db.collection('captures').findOne({ _id: new ObjectId(imageId) });
        if (!image) {
            return res.status(404).json({ success: false, message: '이미지를 찾을 수 없습니다.' });
        }

        const isLiked = image.likedBy.includes(memberId);

        if (isLiked) {
            // 좋아요 취소
            const result = await db.collection('captures').updateOne(
                { _id: new ObjectId(imageId) },
                {
                    $inc: { likes: -1 },
                    $pull: { likedBy: memberId },
                }
            );
            res.json({ success: true, message: '좋아요가 취소되었습니다.', liked: false });
        } else {
            // 좋아요 추가
            const result = await db.collection('captures').updateOne(
                { _id: new ObjectId(imageId) },
                {
                    $inc: { likes: 1 },
                    $push: { likedBy: memberId },
                }
            );
            res.json({ success: true, message: '좋아요가 추가되었습니다!', liked: true });
        }
    } catch (err) {
        console.error('좋아요 처리 오류:', err);
        res.status(500).json({ success: false, message: '좋아요 처리 중 오류가 발생했습니다.' });
    }
});

app.get('/get-like-status', async (req, res) => {
    try {
        const { imageId, memberId } = req.query;

        if (!imageId || !memberId) {
            return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
        }

        const image = await db.collection('captures').findOne({ _id: new ObjectId(imageId) });

        if (!image) {
            return res.status(404).json({ success: false, message: '이미지를 찾을 수 없습니다.' });
        }

        const isLiked = image.likedBy.includes(memberId);
        res.json({ success: true, liked: isLiked });
    } catch (err) {
        console.error('좋아요 상태 확인 오류:', err);
        res.status(500).json({ success: false, message: '좋아요 상태 확인 중 오류가 발생했습니다.' });
    }
});

app.get('/get-top-images', async (req, res) => {
    try {
        const topImages = await db.collection('captures')
            .find()
            .sort({ likes: -1, createdAt: -1 })
            .limit(3)
            .toArray();

        res.json({ success: true, images: topImages });
    } catch (err) {
        console.error('추천 이미지 불러오기 오류:', err);
        res.status(500).json({ success: false, message: '추천 이미지 불러오기 오류' });
    }
});

app.delete('/delete-image', async (req, res) => {
    const { imagePath, memberId } = req.body;
    try {
        const image = await db.collection('captures').findOne({ imagePath });

        if (!image) {
            return res.status(404).json({ success: false, message: '이미지를 찾을 수 없습니다.' });
        }
        if (image.memberId !== memberId && memberId !== 'testid') {
            return res.status(403).json({ success: false, message: '삭제 권한이 없습니다.' });
        }

        await db.collection('captures').deleteOne({ imagePath });
        res.json({ success: true, message: '이미지가 삭제되었습니다.' });
    } catch (error) {
        console.error('이미지 삭제 중 오류:', error);
        res.status(500).json({ success: false, message: '이미지 삭제 중 오류가 발생했습니다.' });
    }
});

app.get('/download-excel', async (req, res) => {
    try {
        const captures = await db.collection('captures').find().toArray();

        if (!captures.length) {
            return res.status(404).json({ success: false, message: '다운로드할 데이터가 없습니다.' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Captures');

        worksheet.columns = [
            { header: 'ID', key: '_id', width: 30 },
            { header: 'Image Path', key: 'imagePath', width: 50 },
            { header: 'Member ID', key: 'memberId', width: 20 },
            { header: 'Likes', key: 'likes', width: 10 },
            { header: 'Created At', key: 'createdAt', width: 25 },
        ];

        captures.forEach(capture => {
            worksheet.addRow({
                _id: capture._id.toString(),
                imagePath: capture.imagePath,
                memberId: capture.memberId || 'N/A',
                likes: capture.likes,
                createdAt: capture.createdAt ? new Date(capture.createdAt).toLocaleString('ko-KR') : 'N/A',
            });
        });

        const filePath = path.join(__dirname, 'captures.xlsx');
        await workbook.xlsx.writeFile(filePath);

        res.download(filePath, 'captures.xlsx', (err) => {
            if (err) {
                console.error('엑셀 파일 다운로드 오류:', err);
            }
            fs.unlinkSync(filePath); // 다운로드 후 파일 삭제
        });

    } catch (err) {
        console.error('엑셀 생성 오류:', err);
        res.status(500).json({ success: false, message: '엑셀 파일 생성 오류' });
    }
});
// ==========================================
// [섹션 B] 고객 행동 추적 및 퍼널 분석 (API 연동 강화판)
// ==========================================

// 0. [신규] Cafe24 회원 정보(수신동의) 조회 함수
async function fetchMemberMarketing(memberId) {
    if (!memberId || memberId === 'GUEST') return null;

    try {
        // Cafe24 Admin API 호출 (회원 상세 정보)
        const url = `https://${MALLID}.cafe24api.com/api/v2/admin/customers`;
        const params = { member_id: memberId, fields: 'is_sms_receipt_on,is_email_receipt_on' };
        
        // 기존에 만들어둔 apiRequest 함수 재사용 (토큰 자동 관리)
        const data = await apiRequest('GET', url, {}, params);

        if (data.customers && data.customers.length > 0) {
            const customer = data.customers[0];
            return {
                sms: customer.is_sms_receipt_on,   // 'T' or 'F'
                email: customer.is_email_receipt_on // 'T' or 'F'
            };
        }
        return null;
    } catch (error) {
        console.error('Member Info Fetch Error:', error.message);
        return null;
    }
}

// 1. [핵심] 로그 수집 API (Cafe24 API 조회 추가)
app.post('/api/track/log', async (req, res) => {
    try {
        const { currentUrl, referrer, sessionId, memberId, cartItems } = req.body;
        // 프론트에서 marketing을 안 보내도 서버에서 조회하므로 제거

        // 🚫 1. 봇 필터링
        if (referrer && (
            referrer.includes('themediatrust') || 
            referrer.includes('gtmetrix') || 
            referrer.includes('bot') || 
            referrer.includes('crawl') ||
            referrer.includes('headless'))) {
            return res.json({ success: true, message: 'Filtered Bot' });
        }

        // 🔍 2. 유입 출처 분류
        let source = '기타';
        const refLower = referrer ? referrer.toLowerCase() : '';

        if (!referrer || referrer.trim() === '' || refLower.includes('yogibo.kr')) {
            source = '주소 직접 입력 방문'; 
        } 
        else if (refLower.includes('naver.com')) source = '네이버';
        else if (refLower.includes('google')) source = '구글';
        else if (refLower.includes('facebook.com')) source = '페이스북';
        else if (refLower.includes('instagram.com')) source = '인스타그램';
        else if (refLower.includes('criteo.com')) source = '크리테오(광고)';
        else if (refLower.includes('kakao.com')) source = '카카오';
        else if (refLower.includes('daum.net')) source = '다음';
        else if (refLower.includes('youtube.com')) source = '유튜브';
        else {
            try { source = new URL(referrer).hostname.replace('www.', ''); } 
            catch (e) { source = '기타'; }
        }

        // 📊 3. 퍼널 단계 판단
        let step = 'VISIT';
        const urlLower = currentUrl.toLowerCase();
        if (urlLower.includes('/order/result.html') || urlLower.includes('/order/order_result.html')) step = 'PURCHASE';
        else if (urlLower.includes('/order/orderform.html')) step = 'CHECKOUT';
        else if (urlLower.includes('/order/basket.html')) step = 'CART';
        else if (urlLower.includes('/product/')) step = 'VIEW_ITEM';

        // ★ [추가] 회원이면 Cafe24 API로 수신동의 여부 조회 (서버가 직접 함)
        let marketingInfo = null;
        if (memberId && memberId !== 'GUEST') {
            // API 호출 (비동기지만 로그 저장을 위해 await)
            marketingInfo = await fetchMemberMarketing(memberId);
        }

        // 💾 4. DB 저장
        const result = await db.collection('access_logs').insertOne({
            sessionId,
            memberId: memberId || 'GUEST',
            source,
            step,
            currentUrl,
            originalReferrer: referrer,
            cartItems: cartItems || [],
            marketing: marketingInfo, // 서버에서 조회한 정확한 정보 저장
            duration: 0,
            createdAt: new Date()
        });

        res.status(200).json({ success: true, logId: result.insertedId });

    } catch (error) {
        console.error('Log Error:', error);
        res.status(500).json({ success: false });
    }
});

// 2. 체류 시간 업데이트 API
app.post('/api/track/time', async (req, res) => {
    try {
        const { logId, duration } = req.body;
        if (!logId) return res.json({ success: false });

        await db.collection('access_logs').updateOne(
            { _id: new ObjectId(logId) },
            { $set: { duration: parseInt(duration) } }
        );
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(200).send();
    }
});

// 3. 통계 조회 API
app.get('/api/track/stats', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = startDate ? new Date(startDate) : new Date(new Date().setHours(0,0,0,0));
        const end = endDate ? new Date(new Date(endDate).setHours(23,59,59,999)) : new Date();

        const stats = await db.collection('access_logs').aggregate([
            { $match: { createdAt: { $gte: start, $lte: end } } },
            { $group: { _id: { source: "$source", step: "$step" }, uniqueUsers: { $addToSet: "$sessionId" } } },
            { $project: { source: "$_id.source", step: "$_id.step", count: { $size: "$uniqueUsers" } } }
        ]).toArray();

        const formattedData = {};
        stats.forEach(item => {
            if (!formattedData[item.source]) formattedData[item.source] = {};
            formattedData[item.source][item.step] = item.count;
        });

        res.json({ success: true, data: formattedData });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// 4. 금일 방문자 목록 조회 API
app.get('/api/track/visitors', async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        const start = new Date(targetDate); start.setHours(0,0,0,0);
        const end = new Date(targetDate); end.setHours(23,59,59,999);

        const visitors = await db.collection('access_logs').aggregate([
            { $match: { createdAt: { $gte: start, $lte: end } } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: "$sessionId",
                    memberId: { $first: "$memberId" },
                    marketing: { $first: "$marketing" }, // 저장된 마케팅 정보 반환
                    lastAction: { $first: "$createdAt" },
                    source: { $first: "$source" },
                    totalActions: { $sum: 1 }
                }
            },
            { $sort: { lastAction: -1 } }
        ]).toArray();

        res.json({ success: true, visitors });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 5. 특정 고객 이동 경로 상세 조회 API
app.get('/api/track/journey', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const journey = await db.collection('access_logs')
            .find({ sessionId: sessionId })
            .sort({ createdAt: 1 })
            .toArray();
        res.json({ success: true, journey });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 6. 봇 데이터 삭제용 임시 API
app.get('/api/clean-bots', async (req, res) => {
    try {
        const result = await db.collection('access_logs').deleteMany({
            originalReferrer: { $regex: 'themediatrust.com' }
        });
        res.send(`${result.deletedCount}개의 봇 데이터를 삭제했습니다.`);
    } catch (e) {
        res.send('삭제 실패: ' + e.message);
    }
});

/**
 * [좌수왕 서버 통합 라우트]
 * * 필수 요구사항:
 * 1. 상단에 const { ObjectId } = require('mongodb'); 가 선언되어 있어야 합니다.
 * 2. db 변수는 MongoDB 데이터베이스 연결 객체여야 합니다. (DB_NAME: yogibo)
 * 3. moment-timezone 라이브러리가 로드되어 있어야 합니다.
 */

// ==========================================
// [설정] 컬렉션 이름 정의
// ==========================================
const jwasuCollectionName = 'offline_jwasu';      // [좌수] 일별 카운트 기록
const staffCollectionName = 'jwasu_managers';     // [관리] 오프라인 매니저 정보 (Admin 등록)
const monthlyTargetCollection = 'jwasu_monthly_targets'; // [NEW] 월별 목표 관리 컬렉션
const cafe24ManagerCollection = 'managers';       // [Legacy] Cafe24용 매니저 컬렉션
const managerSalesCollection = 'manager_salesNew';   // [NEW] 매니저별 매출 기록 (엑셀 업로드용)

// 관리 대상 매장 리스트
const OFFLINE_STORES = [
    "롯데안산", "롯데동탄", "롯데대구", "신세계센텀시티몰",
    "스타필드고양", "스타필드하남", "현대미아", "현대울산",
    "롯데광복", "신세계광주", "신세계대구", "현대중동", "롯데평촌",
    "아브뉴프랑광교", "현대무역센터", "더현대 서울 현대", "청주 현대 커넥트", "현대충청", "NC강남"
];

// ==========================================
// [섹션 C] 오프라인 좌수왕 API (카운트/대시보드)
// ==========================================

// [링크 접속용] 링크 ID로 매니저 정보 조회
app.get('/api/jwasu/link/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: '잘못된 링크입니다.' });

        const manager = await db.collection(staffCollectionName).findOne({ _id: new ObjectId(id) });
        
        if (!manager) {
            return res.json({ success: false, message: '매니저 정보를 찾을 수 없습니다.' });
        }

        if (manager.isActive === false) {
            return res.json({ success: false, message: '현재 비활성화된 링크입니다.', isInactive: true });
        }

        res.json({ success: true, storeName: manager.storeName, managerName: manager.managerName });
    } catch (error) {
        console.error('링크 조회 오류:', error);
        res.status(500).json({ success: false, message: '링크 조회 실패' });
    }
});

// 1. [POST] 좌수 카운트 증가
app.post('/api/jwasu/increment', async (req, res) => {
    try {
        const { storeName, managerName } = req.body;
        const mgrName = managerName || '미지정';

        // ★ [수정] 매장명 검증 로직 완화 (미지정 매장도 카운트 가능하도록 주석 처리)
        // if (!OFFLINE_STORES.includes(storeName)) {
        //     return res.status(400).json({ success: false, message: '등록되지 않은 매장입니다.' });
        // }

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');
        const currentMonthStr = now.format('YYYY-MM');

        const collection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const targetCollection = db.collection(monthlyTargetCollection);

        // 기본 정보 조회
        const staffInfo = await staffCollection.findOne({ storeName: storeName, managerName: mgrName });
        
        // 이번 달 설정된 목표 조회
        const monthlyTarget = await targetCollection.findOne({ month: currentMonthStr, storeName: storeName, managerName: mgrName });

        // 목표 결정: 월별 목표(설정값) > 기본 정보(등록값)
        const finalTargetCount = (monthlyTarget && monthlyTarget.targetCount > 0) ? monthlyTarget.targetCount : (staffInfo ? staffInfo.targetCount : 0);
        const finalMonthlySales = (monthlyTarget && monthlyTarget.targetMonthlySales > 0) ? monthlyTarget.targetMonthlySales : (staffInfo ? staffInfo.targetMonthlySales : 0);
        const finalWeeklySales = (monthlyTarget && monthlyTarget.targetWeeklySales) ? monthlyTarget.targetWeeklySales : (staffInfo ? staffInfo.targetWeeklySales : 0);

        const updateData = {
            $inc: { count: 1 },
            $set: { 
                lastUpdated: new Date(),
                role: staffInfo ? staffInfo.role : '매니저',
                consignment: staffInfo ? staffInfo.consignment : 'N',
                targetCount: finalTargetCount,
                targetMonthlySales: finalMonthlySales,
                targetWeeklySales: finalWeeklySales
            },
            $setOnInsert: { createdAt: new Date() }
        };

        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName, managerName: mgrName },
            updateData,
            { upsert: true, returnDocument: 'after' }
        );

        const updatedDoc = result.value || result; 
        const todayCount = updatedDoc.count;

        const pipeline = [
            { $match: { storeName: storeName, managerName: mgrName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : todayCount;

        res.json({ success: true, storeName, managerName: mgrName, todayCount, monthlyTotal });

    } catch (error) {
        console.error('좌수 증가 오류:', error);
        res.status(500).json({ success: false, message: '카운트 처리 중 오류 발생' });
    }
});

// 2. [POST] 좌수 카운트 취소
app.post('/api/jwasu/undo', async (req, res) => {
    try {
        const { storeName, managerName } = req.body;
        const mgrName = managerName || '미지정';

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');
        const collection = db.collection(jwasuCollectionName);

        const currentDoc = await collection.findOne({ date: todayStr, storeName: storeName, managerName: mgrName });
        if (!currentDoc || currentDoc.count <= 0) {
            return res.status(400).json({ success: false, message: '취소할 내역이 없습니다.' });
        }

        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName, managerName: mgrName },
            { $inc: { count: -1 }, $set: { lastUpdated: new Date() } },
            { returnDocument: 'after' }
        );

        const pipeline = [
            { $match: { storeName: storeName, managerName: mgrName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : 0;
        const updatedDoc = result.value || result;

        res.json({ success: true, storeName, managerName: mgrName, todayCount: updatedDoc ? updatedDoc.count : 0, monthlyTotal });
    } catch (error) {
        console.error('취소 처리 오류:', error);
        res.status(500).json({ success: false, message: '취소 처리 중 오류 발생' });
    }
});

// 3. [GET] 대시보드 데이터 조회
app.get('/api/jwasu/dashboard', async (req, res) => {
    try {
        const queryDate = req.query.date;
        const targetEndDate = queryDate ? queryDate : moment().tz('Asia/Seoul').format('YYYY-MM-DD');
        const targetStartDate = moment(targetEndDate).startOf('month').format('YYYY-MM-DD');
        const targetMonthStr = moment(targetEndDate).format('YYYY-MM');
        
        const collection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const targetCollection = db.collection(monthlyTargetCollection);

        // 공백 제거 정규화 함수
        const normalize = (str) => String(str || '').replace(/\s+/g, '').trim();

        // 1. 매니저 정보 로딩
        const allStaffs = await staffCollection.find().toArray();
        const staffMap = {};
        const nameMap = {};
        const activeSet = new Set();

        allStaffs.forEach(s => {
            const normName = normalize(s.managerName);
            const key = `${normalize(s.storeName)}_${normName}`;
            
            staffMap[key] = s;
            nameMap[normName] = s;
            
            if (s.isActive !== false) activeSet.add(key);
        });

        // 2. 월별 목표 가져오기
        const monthlyTargets = await targetCollection.find({ month: targetMonthStr }).toArray();
        const monthlyTargetMap = {};
        monthlyTargets.forEach(t => {
            const key = `${normalize(t.storeName)}_${normalize(t.managerName)}`;
            monthlyTargetMap[key] = t;
        });

        // 3. 기록 조회
        const records = await collection.find({ 
            date: { $gte: targetStartDate, $lte: targetEndDate } 
        }).toArray();

        const aggregates = {};
        
        // 4. 집계 시작 (기록이 있는 경우)
        records.forEach(record => {
            const mgr = record.managerName || '미지정';
            const normName = normalize(mgr);
            const normStore = normalize(record.storeName);
            
            let uniqueKey = `${normStore}_${normName}`;
            let info = staffMap[uniqueKey];

            if (!info) {
                const found = nameMap[normName];
                if (found) {
                    info = found;
                    uniqueKey = `${normalize(found.storeName)}_${normName}`;
                }
            }

            const mTarget = monthlyTargetMap[uniqueKey];

            let finalTarget = 0;
            let finalSales = 0;
            let finalWeekly = { w1:0, w2:0, w3:0, w4:0, w5:0 };
            let joinDate = null; // [추가] 입사일 변수

            // 목표 및 입사일 우선순위: 월별설정(monthlyTarget) > 매니저기본설정(staffInfo)
            if (mTarget && mTarget.targetCount > 0) finalTarget = mTarget.targetCount;
            else if (record.targetCount > 0) finalTarget = record.targetCount;
            else if (info) finalTarget = info.targetCount;

            if (mTarget && mTarget.targetMonthlySales > 0) finalSales = mTarget.targetMonthlySales;
            else if (record.targetMonthlySales > 0) finalSales = record.targetMonthlySales;
            else if (info) finalSales = info.targetMonthlySales;

            if (mTarget && mTarget.targetWeeklySales) finalWeekly = mTarget.targetWeeklySales;
            else if (record.targetWeeklySales) finalWeekly = record.targetWeeklySales;
            else if (info && info.targetWeeklySales) finalWeekly = info.targetWeeklySales;

            // [추가] 입사일 결정 로직
            if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
            else if (info && info.joinDate) joinDate = info.joinDate;

            if (!aggregates[uniqueKey]) {
                aggregates[uniqueKey] = { 
                    storeName: info ? info.storeName : record.storeName,
                    managerName: mgr,
                    role: record.role || (info ? info.role : '-'),
                    targetCount: finalTarget, 
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, // [확인] 주간목표 포함
                    joinDate: joinDate,             // [추가] 입사일 포함
                    count: 0, 
                    rank: 0,
                    rate: 0
                };
            } else {
                // 기존 데이터 보완 업데이트
                if (aggregates[uniqueKey].targetCount === 0 && finalTarget > 0) aggregates[uniqueKey].targetCount = finalTarget;
                if (aggregates[uniqueKey].targetMonthlySales === 0 && finalSales > 0) aggregates[uniqueKey].targetMonthlySales = finalSales;
                
                const currW = aggregates[uniqueKey].targetWeeklySales;
                if ((!currW || (currW.w1===0 && currW.w2===0)) && (finalWeekly.w1>0 || finalWeekly.w2>0)) {
                    aggregates[uniqueKey].targetWeeklySales = finalWeekly;
                }
                // 입사일 업데이트
                if (!aggregates[uniqueKey].joinDate && joinDate) {
                    aggregates[uniqueKey].joinDate = joinDate;
                }
            }
            
            aggregates[uniqueKey].count += record.count;
        });

        // 5. 기록 없는 활성 매니저 0건으로 추가
        activeSet.forEach(key => {
            if (!aggregates[key]) {
                const info = staffMap[key];
                const mTarget = monthlyTargetMap[key];
                
                const finalTarget = (mTarget && mTarget.targetCount > 0) ? mTarget.targetCount : (info.targetCount || 0);
                const finalSales = (mTarget && mTarget.targetMonthlySales > 0) ? mTarget.targetMonthlySales : (info.targetMonthlySales || 0);
                const finalWeekly = (mTarget && mTarget.targetWeeklySales) ? mTarget.targetWeeklySales : (info.targetWeeklySales || { w1:0, w2:0, w3:0, w4:0, w5:0 });
                
                // [추가] 입사일 결정 로직
                let joinDate = null;
                if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
                else if (info && info.joinDate) joinDate = info.joinDate;

                aggregates[key] = {
                    storeName: info.storeName,
                    managerName: info.managerName,
                    role: info.role || '-',
                    targetCount: finalTarget,
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, // [확인] 주간목표 포함
                    joinDate: joinDate,             // [추가] 입사일 포함
                    count: 0,
                    rank: 0,
                    rate: 0
                };
            }
        });

        const dashboardData = Object.values(aggregates);

        // 6. 달성률 및 랭킹
        dashboardData.forEach(item => {
            if (item.targetCount > 0) {
                item.rate = parseFloat(((item.count / item.targetCount) * 100).toFixed(1));
            } else {
                item.rate = 0;
            }
        });

        dashboardData.sort((a, b) => {
            if (b.rate !== a.rate) return b.rate - a.rate;
            return b.count - a.count;
        });

        dashboardData.forEach((item, index) => { item.rank = index + 1; });
        const totalCount = dashboardData.reduce((acc, cur) => acc + cur.count, 0);

        res.json({ success: true, startDate: targetStartDate, endDate: targetEndDate, totalCount, data: dashboardData });

    } catch (error) {
        console.error('대시보드 조회 오류:', error);
        res.status(500).json({ success: false, message: '대시보드 데이터 조회 오류' });
    }
});

// ==========================================
// [섹션 - 통합 조회] 테이블 API (좌수 데이터 로드용) - 누락된 부분 복구
// ==========================================
app.get('/api/jwasu/table', async (req, res) => {
    try {
        const { store, startDate, endDate } = req.query;
        
        // 1. 날짜 및 매장 필터 조건 생성
        let query = {};
        
        // 날짜 필터
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        }
        
        // 매장 필터
        if (store && store !== 'all') {
            query.storeName = store; 
        }

        // 2. DB에서 좌수 데이터 조회 (offline_jwasu 컬렉션)
        const jwasuList = await db.collection(jwasuCollectionName)
                                  .find(query)
                                  .sort({ date: -1 }) // 최신순 정렬
                                  .toArray();

        // 3. 클라이언트로 보낼 데이터 포맷팅
        const report = jwasuList.map(item => ({
            type: 'jwasu',
            date: item.date,
            storeName: item.storeName || '알수없음',
            managerName: item.managerName || '미지정',
            role: item.role || '-',
            count: item.count || 0,
            revenue: 0 // 매출은 별도 API(manager-sales)에서 합치므로 여기선 0
        }));
        
        res.status(200).json({ success: true, report: report });

    } catch (error) {
        console.error("좌수 테이블 조회 오류:", error);
        res.status(500).json({ success: false, message: '서버 내부 오류' });
    }
});

// ==========================================
// [섹션 G] 월별 목표 관리 API (팝업용)
// ==========================================

// [GET] 목표 조회 (기존 유지 - 저장된 joinDate가 있으면 자동으로 가져옵니다)
app.get('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        const { month, storeName, managerName } = req.query;
        if (!month || !storeName || !managerName) return res.status(400).json({ success: false });

        const target = await db.collection(monthlyTargetCollection).findOne({ month, storeName, managerName });
        res.json({ success: true, data: target || {} });
    } catch (error) { res.status(500).json({ success: false }); }
});

// [POST] 목표 설정 (입사일 joinDate 추가)
app.post('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        // 1. joinDate 추가로 받기
        const { 
            month, storeName, managerName, 
            targetCount, targetMonthlySales, targetWeeklySales, 
            w1, w2, w3, w4, w5, 
            joinDate // <--- 여기 추가됨
        } = req.body;
        
        let weeklySalesData = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };

        // 주간 데이터 숫자 변환 (기존 로직 유지)
        if (targetWeeklySales && typeof targetWeeklySales === 'object') {
            weeklySalesData.w1 = parseInt(targetWeeklySales.w1) || 0;
            weeklySalesData.w2 = parseInt(targetWeeklySales.w2) || 0;
            weeklySalesData.w3 = parseInt(targetWeeklySales.w3) || 0;
            weeklySalesData.w4 = parseInt(targetWeeklySales.w4) || 0;
            weeklySalesData.w5 = parseInt(targetWeeklySales.w5) || 0;
        } else {
            weeklySalesData.w1 = parseInt(w1) || 0;
            weeklySalesData.w2 = parseInt(w2) || 0;
            weeklySalesData.w3 = parseInt(w3) || 0;
            weeklySalesData.w4 = parseInt(w4) || 0;
            weeklySalesData.w5 = parseInt(w5) || 0;
        }

        await db.collection(monthlyTargetCollection).updateOne(
            { month, storeName, managerName },
            { 
                $set: { 
                    targetCount: parseInt(targetCount) || 0,
                    targetMonthlySales: parseInt(targetMonthlySales) || 0,
                    targetWeeklySales: weeklySalesData,
                    joinDate: joinDate || null, // <--- 2. DB에 저장 (값이 없으면 null)
                    updatedAt: new Date()
                } 
            },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) { 
        console.error("목표 저장 오류:", error);
        res.status(500).json({ success: false }); 
    }
});

// ==========================================
// [섹션 E] 관리자 API (매니저 관리)
// ==========================================
app.get('/api/jwasu/admin/managers', async (req, res) => {
    try {
        const managers = await db.collection(staffCollectionName).find().sort({ storeName: 1, managerName: 1 }).toArray();
        res.json({ success: true, managers });
    } catch (error) { res.status(500).json({ success: false }); }
});

// [수정] 매니저 등록 시 중복 체크 강화 (매장+이름+직급)
app.post('/api/jwasu/admin/manager', async (req, res) => {
    try {
        const { storeName, managerName, role, consignment, targetCount, targetMonthlySales, targetWeeklySales, isActive } = req.body;
        if (!storeName || !managerName) return res.status(400).json({ success: false });
        
        // ★ [변경] 이름뿐만 아니라 직급(role)까지 포함하여 중복 체크
        // role이 없는 경우(기존 데이터) 고려하여 $or 조건 또는 기본값 처리 필요하지만, 
        // 신규 등록이므로 role은 필수값으로 처리하거나 빈 문자열로 처리
        const checkRole = role || '';

        const exists = await db.collection(staffCollectionName).findOne({ 
            storeName, 
            managerName,
            role: checkRole
        });
        
        if (exists) return res.status(400).json({ success: false, message: '이미 등록된 매니저입니다 (동일 매장/이름/직급).' });

        await db.collection(staffCollectionName).insertOne({
            storeName, 
            managerName, 
            role: role || '매니저', 
            consignment: consignment || 'N',
            targetCount: parseInt(targetCount) || 0,
            targetMonthlySales: parseInt(targetMonthlySales) || 0,
            targetWeeklySales: parseInt(targetWeeklySales) || 0,
            isActive: isActive !== undefined ? isActive : true,
            createdAt: new Date()
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/jwasu/admin/manager/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { storeName, managerName, role, consignment, targetCount, targetMonthlySales, targetWeeklySales } = req.body;
        await db.collection(staffCollectionName).updateOne(
            { _id: new ObjectId(id) },
            { $set: { storeName, managerName, role, consignment, targetCount: parseInt(targetCount)||0, targetMonthlySales: parseInt(targetMonthlySales)||0, targetWeeklySales: parseInt(targetWeeklySales)||0, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});





app.put('/api/jwasu/admin/manager/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body; 
        await db.collection(staffCollectionName).updateOne({ _id: new ObjectId(id) }, { $set: { isActive: isActive } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});
// [매니저 삭제 API]
app.delete('/api/jwasu/admin/manager/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // ID 유효성 검사
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "유효하지 않은 ID입니다." });
        }

        const result = await db.collection(staffCollectionName).deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 1) {
            res.json({ success: true, message: "삭제되었습니다." });
        } else {
            res.status(404).json({ success: false, message: "해당 매니저를 찾을 수 없습니다." });
        }
    } catch (error) {
        console.error("삭제 오류:", error);
        res.status(500).json({ success: false, message: "서버 오류로 삭제 실패" });
    }
});


// [섹션 - 기타 통계] - my-stats 추가
app.get('/api/jwasu/my-stats', async (req, res) => {
    try {
        const { storeName, managerName } = req.query;
        if (!storeName) return res.status(400).json({ success: false });

        const now = moment().tz('Asia/Seoul');
        const startOfThisMonth = now.clone().startOf('month').format('YYYY-MM-DD');
        const endOfThisMonth = now.clone().endOf('month').format('YYYY-MM-DD');
        
        const collection = db.collection(jwasuCollectionName);
        
        const query = { storeName: storeName, date: { $gte: startOfThisMonth, $lte: endOfThisMonth } };
        if (managerName) query.managerName = managerName;
        
        const dailyRecords = await collection.find(query).sort({ date: -1 }).toArray();
        res.json({ success: true, data: dailyRecords });
    } catch (error) { res.status(500).json({ success: false }); }
});

// [섹션 - 월별 히스토리] - monthly-history 추가
app.get('/api/jwasu/monthly-history', async (req, res) => {
    try {
        const { month } = req.query;
        if (!month) return res.status(400).json({ success: false });
        
        const startOfMonth = moment(month).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = moment(month).endOf('month').format('YYYY-MM-DD');
        
        const collection = db.collection(jwasuCollectionName);
        const pipeline = [ 
            { $match: { date: { $gte: startOfMonth, $lte: endOfMonth } } }, 
            { $group: { _id: { store: "$storeName", manager: "$managerName" }, totalCount: { $sum: "$count" } } } 
        ];
        
        const aggResults = await collection.aggregate(pipeline).toArray();
        const historyData = aggResults.map(item => ({ 
            storeName: item._id.store, 
            managerName: item._id.manager || '미지정', 
            count: item.totalCount, 
            rank: 0 
        }));
        
        historyData.sort((a, b) => b.count - a.count);
        historyData.forEach((item, index) => item.rank = index + 1);
        
        res.json(historyData);
    } catch (error) { res.status(500).json({ success: false }); }
});

// [섹션 F] 기존 좌수 엑셀 업로드 (이름 기준)
app.post('/api/jwasu/upload-excel', async (req, res) => {
    try {
        const { data } = req.body; 
        if (!Array.isArray(data) || data.length === 0) return res.status(400).json({ success: false, message: '데이터가 없습니다.' });
        
        const jwasuCollection = db.collection(jwasuCollectionName);
        const staffCollection = db.collection(staffCollectionName);
        const allStaffs = await staffCollection.find().toArray();
        const staffMap = {};
        allStaffs.forEach(s => { if (s.managerName) { const cleanName = String(s.managerName).replace(/\s+/g, '').trim(); staffMap[cleanName] = s; } });

        const dailyOperations = [];
        const managerUpdates = new Map();

        data.forEach(item => {
            let excelStore = String(item.storeName || '').trim();
            let excelName = String(item.managerName || '미지정').trim();
            const dateStr = item.date;
            const count = parseInt(item.count) || 0;
            const target = parseInt(item.target) || 0; 

            const cleanExcelName = excelName.replace(/\s+/g, '');
            const staffInfo = staffMap[cleanExcelName];

            const finalStoreName = staffInfo ? staffInfo.storeName : excelStore;
            const finalManagerName = staffInfo ? staffInfo.managerName : excelName;

            dailyOperations.push({
                updateOne: {
                    filter: { date: dateStr, storeName: finalStoreName, managerName: finalManagerName },
                    update: {
                        $set: {
                            count: count,
                            lastUpdated: new Date(),
                            role: staffInfo ? staffInfo.role : '매니저',
                            consignment: staffInfo ? staffInfo.consignment : 'N',
                            targetCount: target > 0 ? target : (staffInfo ? staffInfo.targetCount : 0),
                            targetMonthlySales: staffInfo ? (staffInfo.targetMonthlySales || 0) : 0,
                            targetWeeklySales: staffInfo ? (staffInfo.targetWeeklySales || 0) : 0
                        },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    upsert: true
                }
            });

            if (target > 0 && staffInfo) {
               managerUpdates.set(staffInfo._id.toString(), target);
            }
        });

        if (dailyOperations.length > 0) {
            await jwasuCollection.bulkWrite(dailyOperations);
        }
        
        if (managerUpdates.size > 0) {
            const mgrOps = [];
            managerUpdates.forEach((newTarget, mgrId) => {
                mgrOps.push({
                    updateOne: {
                        filter: { _id: new ObjectId(mgrId) },
                        update: { $set: { targetCount: newTarget } }
                    }
                });
            });
            await staffCollection.bulkWrite(mgrOps);
        }

        res.json({ success: true, message: `총 ${dailyOperations.length}건 처리 완료` });
    } catch (error) { res.status(500).json({ success: false, message: '업로드 중 서버 오류 발생' }); }
});


// ==========================================
// [섹션 H] 매니저 매출 관리 (New Feature)
// * 컬렉션: manager_salesNew
// * 기능: 엑셀 업로드 및 조회
// ==========================================

// [GET] 매니저 매출 데이터 조회
app.get('/api/manager-sales', async (req, res) => {
    try {
        const { date, storeName } = req.query; // 필터 옵션
        const query = {};
        
        if (date) query.date = date; // 'YYYY-MM-DD' 형식
        if (storeName) query.storeName = storeName;

        const collection = db.collection(managerSalesCollection);
        // 날짜 내림차순, 매장명 오름차순 정렬
        const results = await collection.find(query).sort({ date: -1, storeName: 1 }).toArray();

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('매니저 매출 조회 오류:', error);
        res.status(500).json({ success: false, message: '매출 데이터 조회 실패' });
    }
});

// [POST] 매니저 매출 엑셀 업로드
app.post('/api/manager-sales/upload-excel', async (req, res) => {
    try {
        const { data } = req.body; 
        
        if (!Array.isArray(data) || data.length === 0) {
            return res.status(400).json({ success: false, message: '데이터가 없습니다.' });
        }

        const collection = db.collection(managerSalesCollection);
        const bulkOps = [];

        data.forEach(item => {
            const dateStr = item.date; // 엑셀에서 파싱된 'YYYY-MM-DD'
            const storeName = String(item.storeName || '').trim();
            const managerName = String(item.managerName || '미지정').trim();
            const salesAmount = parseInt(item.salesAmount) || 0; 
            
            // 필수 키가 있을 경우에만 업데이트
            if (dateStr && storeName) {
                bulkOps.push({
                    updateOne: {
                        filter: { date: dateStr, storeName: storeName, managerName: managerName },
                        update: {
                            $set: {
                                salesAmount: salesAmount,
                                revenue: salesAmount,
                                type: 'sales',
                                lastUpdated: new Date()
                            },
                            $setOnInsert: { 
                                createdAt: new Date(),
                                count: 0,
                                role: ''
                            }
                        },
                        upsert: true // 데이터가 없으면 insert, 있으면 update
                    }
                });
            }
        });

        if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
        }

        res.json({ success: true, message: `총 ${bulkOps.length}건의 매출 데이터 처리 완료` });

    } catch (error) {
        console.error('매니저 매출 엑셀 업로드 오류:', error);
        res.status(500).json({ success: false, message: '매출 업로드 중 오류 발생' });
    }
});








// ==========================================
// [API 라우터 시작] (작성하신 코드)  12월 이벤트 
// ==========================================

// 1. [당첨자 명단 조회 API]
app.get('/api/event-winners', async (req, res) => {
    try {
      // ★ db 변수가 위에서 연결된 상태여야 함
      const collection = db.collection('event12_collection');
  
      const winners = await collection.find({ status: 'win' })
        .sort({ updatedAt: -1 }) 
        .limit(50) 
        .toArray();
  
      const maskedWinners = winners.map(w => {
        let id = w.userId || 'guest';
        if (id.length > 3) {
          id = id.slice(0, -3) + 'xxx'; 
        } else {
          id = id + 'xxx';
        }
        return { maskedId: id };
      });
  
      res.json({ success: true, winners: maskedWinners });
  
    } catch (error) {
      console.error('당첨자 조회 오류:', error);
      res.status(500).json({ success: false, winners: [] });
    }
});

// 2. [이벤트 참여 API]
app.post('/api/play-event', async (req, res) => {
    try {
      const { userId, isRetry } = req.body; 
  
      // ★ 크리스마스 이벤트 확률 데이터 부분
      const MAX_DAILY_WINNERS = 10; 
      const WIN_PROBABILITY_PERCENT = 10; 
  
      // ★ 쿠폰 정보 (실제 발급될 쿠폰 번호와 이동 URL)
      const PRIZE_COUPON_NO = "6083836502100001083";
      const PRIZE_TARGET_URL = "https://yogibo.kr/surl/P/2571";
  
      if (!userId) {
        return res.status(400).json({ success: false, message: '로그인이 필요합니다.' });
      }
  
      const now = moment().tz('Asia/Seoul');
      const todayStr = now.format('YYYY-MM-DD');
      const collection = db.collection('event12_collection');
  
      console.log(`[EVENT] 유저: ${userId}, 재도전: ${isRetry}`);
  
      // (1) 평생 중복 체크 (★ 이 부분이 수정되었습니다)
      const existingWin = await collection.findOne({ userId: userId, status: 'win' });
      if (existingWin) {
        // 이미 당첨된 경우: 쿠폰 다운로드 버튼을 다시 띄우기 위해 당첨 응답을 재전송합니다.
        console.log('-> 결과: 이미 과거 당첨자, 쿠폰 다운로드 기회 재부여.');
        
        // 프론트엔드에서 승리 팝업(showPopup('win', ...))을 다시 띄우도록 응답
        return res.status(200).json({ 
          success: true,           // 성공으로 처리
          code: 'ALREADY_WON_REPLAY', // 새로운 코드로 구분
          isWin: true,             // 당첨 상태로 간주
          message: '이미 당첨되셨습니다. 쿠폰을 다시 다운로드하시겠습니까?',
          tryCount: 2,             // 팝업 로직에 영향 주지 않도록 2로 설정
          couponData: { couponNo: PRIZE_COUPON_NO, targetUrl: PRIZE_TARGET_URL } 
        });
      }
  
      // (2) 오늘 참여 이력 체크 (기존 로직 유지)
      const todayRecord = await collection.findOne({ userId: userId, date: todayStr });
      
      if (todayRecord) {
        if (todayRecord.tryCount >= 2 || todayRecord.status === 'win') {
          return res.status(200).json({ success: false, code: 'DAILY_LIMIT_EXCEEDED', message: '오늘의 기회 소진' });
        }
        if (!isRetry) {
          return res.status(200).json({ success: false, code: 'RETRY_AVAILABLE', message: '공유 후 재도전 가능', tryCount: 1 });
        }
      }
  
      // (3) 당첨 여부 결정 (기존 로직 유지)
      const dailyWinnerCount = await collection.countDocuments({ date: todayStr, status: 'win' });
      
      let isWin = false;
      if (dailyWinnerCount < MAX_DAILY_WINNERS) { 
            const randomVal = Math.random() * 100;
            if (randomVal < WIN_PROBABILITY_PERCENT) {
              isWin = true;
            }
      }
  
      const resultStatus = isWin ? 'win' : 'lose';
  
      // (4) DB 업데이트/저장 (기존 로직 유지)
      if (todayRecord) {
        await collection.updateOne(
          { _id: todayRecord._id },
          { $set: { status: resultStatus, updatedAt: new Date() }, $inc: { tryCount: 1 } }
        );
      } else {
        await collection.insertOne({
          userId: userId, date: todayStr, status: resultStatus, tryCount: 1, createdAt: new Date()
        });
      }
  
      // (5) 응답 (기존 로직 유지)
      res.status(200).json({
        success: true,
        code: 'RESULT',
        isWin: isWin,
        message: isWin ? '축하합니다! 당첨되셨습니다.' : '아쉽지만 꽝입니다.',
        tryCount: todayRecord ? 2 : 1,
        couponData: isWin ? { couponNo: PRIZE_COUPON_NO, targetUrl: PRIZE_TARGET_URL } : null
      });
  
    } catch (error) {
      console.error('이벤트 에러:', error);
      res.status(500).json({ success: false, message: '서버 오류' });
    }
});

// 3. [카카오 키 조회 API] (추가된 부분)
app.get('/api/kakao-key', (req, res) => {
    // .env 파일의 KAKAO_JS_KEY를 읽어서 반환
    const key = process.env.KAKAO_JS_KEY;
    
    if (!key) {
        console.error("❌ 서버 경고: .env 파일에 KAKAO_JS_KEY가 없습니다.");
    }

    res.json({
        success: true,
        key: key 
    });
});
app.get('/api/12Event', async (req, res) => {
    try {
        const collection = db.collection('event12_collection');

        // 1. 데이터 조회 (DB)
        const allRecords = await collection.find({})
            .project({ _id: 0, userId: 1, date: 1, tryCount: 1, status: 1, createdAt: 1 })
            .sort({ createdAt: 1 })
            .toArray();

        // 2. Excel Workbook 및 Worksheet 생성
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('이벤트 참여 기록');

        // 3. 헤더 정의 (순서와 이름 지정)
        worksheet.columns = [
            { header: '참여 아이디', key: 'userId', width: 20 },
            { header: '참여 날짜 (KST)', key: 'date', width: 15 },
            { header: '총 시도 횟수', key: 'tryCount', width: 10 },
            { header: '최종 결과', key: 'status', width: 10 },
        ];

        // 4. 데이터 추가
        // MongoDB에서 가져온 데이터를 워크시트에 바로 추가합니다.
        worksheet.addRows(allRecords);

        // 5. HTTP 응답 헤더 설정 (.xlsx 파일 다운로드 유도)
        res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.attachment('event_participants_' + moment().format('YYYYMMDD_HHmmss') + '.xlsx');
        
        // 6. 파일 전송
        await workbook.xlsx.write(res);
        res.end(); // 응답 완료

    } catch (error) {
        console.error('Excel 익스포트 오류:', error);
        res.status(500).send('서버 오류: 엑셀 파일을 생성할 수 없습니다.');
    }
});




//응모하기 이벤트 12월05일
// --- [섹션 D] 이벤트 응모 API (단일 참여 제한) ---
const EVENT_COLLECTION_NAME = 'event_raffle_entries'; 
const EVENT_PERIOD_START = '2025-12-01'; // 이벤트 시작일 설정
const EVENT_PERIOD_END = '2025-12-28'; // 이벤트 종료일 설정

// 응모 API
app.post('/api/raffle/entry', async (req, res) => {
    try {
        const { userId, optionName } = req.body;
        
        // 1. 필수값 체크 및 회원 여부 확인
        if (!userId || userId === 'GUEST') {
            return res.status(401).json({ success: false, message: '회원 로그인 후 참여 가능합니다.' });
        }
        if (!optionName) {
            return res.status(400).json({ success: false, message: '옵션(경품)을 선택해주세요.' });
        }

        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');

        // 2. 이벤트 기간 확인
        if (todayStr < EVENT_PERIOD_START || todayStr > EVENT_PERIOD_END) {
             return res.status(403).json({ success: false, message: '이벤트 기간이 아닙니다.' });
        }

        const collection = db.collection(EVENT_COLLECTION_NAME);

        // 3. 참여 기록 확인 (유저의 모든 옵션에 대한 참여 기록)
        // userId가 일치하는 문서가 하나라도 있으면 참여한 것으로 간주
        const existingEntry = await collection.findOne({ userId: userId });

        if (existingEntry) {
            // 다른 옵션 포함하여 이미 참여한 경우
            return res.status(200).json({ 
                success: false, 
                code: 'ALREADY_ENTERED', 
                message: `이미 ${existingEntry.optionName} 옵션으로 응모하셨습니다. (1회 제한)` 
            });
        }

        // 4. 응모 기록 저장 (1회만 허용되므로 새로운 레코드 삽입)
        const newEntry = {
            userId: userId,
            optionName: optionName,
            entryDate: todayStr,
            createdAt: new Date(),
        };

        const result = await collection.insertOne(newEntry);

        res.status(200).json({
            success: true,
            message: `이벤트 응모가 완료되었습니다. [${optionName}]`,
            entryId: result.insertedId,
        });

    } catch (error) {
        console.error('이벤트 응모 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류: 응모 처리 중 문제가 발생했습니다.' });
    }
});

// 응모 현황 조회 API (선택)
app.get('/api/raffle/status', async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId || userId === 'GUEST') {
            return res.status(401).json({ success: false, isEntered: false, message: '로그인이 필요합니다.' });
        }

        const collection = db.collection(EVENT_COLLECTION_NAME);
        const existingEntry = await collection.findOne({ userId: userId });
        
        if (existingEntry) {
            return res.json({ 
                success: true, 
                isEntered: true, 
                optionName: existingEntry.optionName,
                message: `이미 [${existingEntry.optionName}]으로 응모하셨습니다.`
            });
        } else {
             return res.json({ success: true, isEntered: false, message: '응모 가능합니다.' });
        }

    } catch (error) {
        console.error('응모 상태 조회 오류:', error);
        res.status(500).json({ success: false, isEntered: false, message: '서버 오류' });
    }
});


// [추가] 이벤트 응모 기록 엑셀 다운로드 API
app.get('/api/12', async (req, res) => {
    try {
        const collection = db.collection(EVENT_COLLECTION_NAME); // event_raffle_entries

        // 1. 모든 응모 기록을 최신순으로 조회
        const entries = await collection.find({})
            .sort({ createdAt: -1 })
            .toArray();

        if (!entries.length) {
            return res.status(404).json({ success: false, message: '다운로드할 이벤트 응모 데이터가 없습니다.' });
        }

        // 2. Excel Workbook 및 Worksheet 생성
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('EventEntries');

        // 3. 컬럼 정의
        worksheet.columns = [
            { header: '회원 ID', key: 'userId', width: 25 },
            { header: '응모 날짜', key: 'entryDate', width: 15 },
            { header: '선택 옵션', key: 'optionName', width: 40 },
        ];

        // 4. 데이터 추가
        entries.forEach((entry, index) => {
            worksheet.addRow({
                index: index + 1,
                _id: entry._id.toString(),
                userId: entry.userId || 'N/A',
                entryDate: entry.entryDate || 'N/A',
                optionName: entry.optionName || 'N/A',
                createdAt: entry.createdAt ? moment(entry.createdAt).tz('Asia/Seoul').format('YYYY-MM-DD HH:mm:ss') : 'N/A',
            });
        });

        // 5. 파일 생성 및 다운로드
        const filename = `event_raffle_entries_${moment().tz('Asia/Seoul').format('YYYYMMDD_HHmmss')}.xlsx`;
        const filePath = path.join(__dirname, filename);
        
        // 파일을 서버 로컬에 쓰고
        await workbook.xlsx.writeFile(filePath);

        // 클라이언트에게 다운로드 요청
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('엑셀 파일 다운로드 오류:', err);
            }
            // 다운로드 완료 후 파일 삭제 (선택적)
            try {
                fs.unlinkSync(filePath); 
            } catch (e) {
                console.error('엑셀 파일 삭제 오류:', e);
            }
        });

    } catch (err) {
        console.error('이벤트 응모 엑셀 생성 오류:', err);
        res.status(500).json({ success: false, message: '엑셀 파일 생성 오류' });
    }
});

// [추가] 총 응모자 수 조회 API
// [수정] 옵션별 응모자 수 조회 API
app.get('/api/raffle/total-count', async (req, res) => {
    try {
        const collection = db.collection(EVENT_COLLECTION_NAME); // event_raffle_entries

        // MongoDB Aggregation Pipeline을 사용하여 옵션별 count를 집계
        const pipeline = [
            {
                $group: {
                    _id: "$optionName", // optionName 기준으로 그룹화
                    count: { $sum: 1 }   // 각 그룹의 문서 수 카운트
                }
            },
            {
                $project: {
                    _id: 0, // _id 필드는 제외
                    optionName: "$_id",
                    count: 1
                }
            }
        ];

        const results = await collection.aggregate(pipeline).toArray();

        // 결과를 프론트엔드가 사용하기 쉬운 Map 형태로 변환
        const totalCounts = results.reduce((acc, item) => {
            acc[item.optionName] = item.count;
            return acc;
        }, {});
        
        // 모든 옵션을 포함하도록 기본값 0 설정 (응모 기록이 없어도 표시되도록)
        const ALL_OPTIONS = [
            "이북리더기 - 마스 7",
            "메가 문필로우",
            "웨이브 12개월 Basic 구독권"
        ];
        
        const finalCounts = {};
        ALL_OPTIONS.forEach(option => {
            finalCounts[option] = totalCounts[option] || 0;
        });

        res.json({ success: true, counts: finalCounts });

    } catch (error) {
        console.error('옵션별 응모자 수 조회 오류:', error);
        res.status(500).json({ success: false, counts: {}, message: '서버 오류' });
    }
});
// --- 8. 서버 시작 ---
mongoClient.connect()
    .then(client => {
        console.log('MongoDB 연결 성공');
        db = client.db(dbName); // 전역 db 객체 할당

        // MongoDB 연결 후에 서버 리스닝 시작
        app.listen(PORT, async () => {
            console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
            
            // 랭킹 서버 초기화 로직 (Cafe24)
            await getTokensFromDB(); // DB에서 토큰 로드

            // 스케줄: 매 시간 정각에 토큰 갱신
            schedule.scheduleJob('0 * * * *', async () => {
                console.log('스케줄 작업 실행: 토큰 갱신 시작');
                try {
                    await refreshAccessToken();
                    console.log('토큰 갱신 완료');
                } catch (error) {
                    console.error('스케줄된 토큰 갱신 중 오류 발생:', error.message);
                }
            });

            // 서버 시작 시 랭킹 데이터 1회 초기화
            await initializeServer();
        });
    })
    .catch(err => {
        console.error('MongoDB 연결 실패:', err);
        process.exit(1); // MongoDB 연결 실패 시 서버 종료
    });