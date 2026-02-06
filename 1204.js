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




// ==========================================
// [섹션 C] 오프라인 좌수왕(Seat Count) 시스템 (최종 정제버전)
// ==========================================

const jwasuCollectionName = 'offline_jwasu'; // 좌수 데이터 컬렉션

// 1. 관리 대상 매장 리스트
const OFFLINE_STORES = [
    "롯데안산",
    "롯데동탄",
    "롯데대구",
    "신세계센텀시티몰",
    "스타필드고양",
    "스타필드하남",
    "현대미아",
    "현대울산"
];
// 2. [POST] 좌수 카운트 증가 API (버그 수정됨)
app.post('/api/jwasu/increment', async (req, res) => {
    try {
        const { storeName } = req.body;

        if (!OFFLINE_STORES.includes(storeName)) {
            return res.status(400).json({ success: false, message: '등록되지 않은 매장입니다.' });
        }

        // 날짜 계산
        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');

        const collection = db.collection(jwasuCollectionName);

        // 1. 오늘 날짜 카운트 증가
        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName },
            { 
                $inc: { count: 1 }, 
                $set: { lastUpdated: new Date() },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );

        // [수정 포인트] MongoDB 드라이버 버전에 따라 리턴 구조가 다름을 방어하는 코드
        // result.value가 있으면(구버전) 쓰고, 없으면 result 자체(신버전)를 씁니다.
        const updatedDoc = result.value || result; 
        const todayCount = updatedDoc.count;

        // 2. 이번 달 전체 누적 합계 계산
        const pipeline = [
            { 
                $match: { 
                    storeName: storeName,
                    date: { $gte: startOfMonth, $lte: todayStr }
                } 
            },
            { 
                $group: { 
                    _id: null, 
                    total: { $sum: "$count" }
                } 
            }
        ];
        
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : todayCount;

        // 3. 두 가지 값 모두 반환
        res.json({ 
            success: true, 
            storeName: storeName, 
            todayCount: todayCount,    // 오늘 누적
            monthlyTotal: monthlyTotal // 이번달 총합
        });

    } catch (error) {
        console.error('좌수 증가 오류:', error);
        // 에러 상세 내용을 로그로 확인하기 위해 error 객체 출력
        console.log(error); 
        res.status(500).json({ success: false, message: '카운트 처리 중 오류 발생' });
    }
});

// [추가] 2-1. [POST] 좌수 카운트 취소 (Undo) API
app.post('/api/jwasu/undo', async (req, res) => {
    try {
        const { storeName } = req.body;

        // 오늘 날짜 및 이번 달 1일 계산
        const now = moment().tz('Asia/Seoul');
        const todayStr = now.format('YYYY-MM-DD');
        const startOfMonth = now.startOf('month').format('YYYY-MM-DD');

        const collection = db.collection(jwasuCollectionName);

        // 1. 해당 매장의 오늘 데이터 검색
        const currentDoc = await collection.findOne({ date: todayStr, storeName: storeName });

        // 데이터가 없거나 카운트가 0이면 취소 불가
        if (!currentDoc || currentDoc.count <= 0) {
            return res.status(400).json({ success: false, message: '취소할 내역이 없습니다.' });
        }

        // 2. 카운트 1 감소 ($inc: -1)
        const result = await collection.findOneAndUpdate(
            { date: todayStr, storeName: storeName },
            { 
                $inc: { count: -1 }, 
                $set: { lastUpdated: new Date() } 
            },
            { returnDocument: 'after' }
        );

        // 3. 감소된 후의 이번 달 누적 합계 다시 계산
        const pipeline = [
            { $match: { storeName: storeName, date: { $gte: startOfMonth, $lte: todayStr } } },
            { $group: { _id: null, total: { $sum: "$count" } } }
        ];
        
        const aggResult = await collection.aggregate(pipeline).toArray();
        const monthlyTotal = aggResult.length > 0 ? aggResult[0].total : 0;

        // 결과 반환
        res.json({ 
            success: true, 
            storeName: storeName, 
            todayCount: result.value ? result.value.count : result.count, // 버전 호환 처리
            monthlyTotal: monthlyTotal 
        });

    } catch (error) {
        console.error('취소 처리 오류:', error);
        res.status(500).json({ success: false, message: '취소 처리 중 오류 발생' });
    }
});

// 3. [GET] 대시보드 데이터 조회 (월초 ~ 선택일까지 누적 집계)
app.get('/api/jwasu/dashboard', async (req, res) => {
    try {
        // 1. 날짜 범위 설정 로직
        // 쿼리로 받은 날짜가 없으면 오늘 날짜 사용
        const queryDate = req.query.date;
        const targetEndDate = queryDate ? queryDate : moment().tz('Asia/Seoul').format('YYYY-MM-DD');
        
        // 해당 날짜가 속한 달의 1일 구하기 (예: 2025-11-25 -> 2025-11-01)
        const targetStartDate = moment(targetEndDate).startOf('month').format('YYYY-MM-DD');

        const collection = db.collection(jwasuCollectionName);

        // 2. DB 조회: [월초 ~ 선택일] 사이의 모든 기록 가져오기
        const records = await collection.find({ 
            date: { 
                $gte: targetStartDate, // 크거나 같다 (1일)
                $lte: targetEndDate    // 작거나 같다 (선택일)
            } 
        }).toArray();

        // 3. 매장별 누적 합계 계산 (Aggregation)
        // DB에서 가져온 여러 날짜의 기록들을 매장별로 묶어서 더함
        const storeAggregates = {};
        
        records.forEach(record => {
            if (!storeAggregates[record.storeName]) {
                storeAggregates[record.storeName] = 0;
            }
            storeAggregates[record.storeName] += record.count;
        });

        // 4. 전체 매장 리스트(OFFLINE_STORES)를 기준으로 최종 데이터 포맷팅
        // 기록이 아예 없는 매장도 0으로 표시하기 위함
        const dashboardData = OFFLINE_STORES.map(store => {
            return {
                storeName: store,
                // 계산해둔 합계가 있으면 쓰고, 없으면 0
                count: storeAggregates[store] || 0, 
                rank: 0 
            };
        });

        // 5. 카운트 기준 내림차순 정렬 (랭킹)
        dashboardData.sort((a, b) => b.count - a.count);

        // 6. 랭킹 번호 부여
        dashboardData.forEach((item, index) => {
            item.rank = index + 1;
        });

        // 7. 전체 총합 계산
        const totalCount = dashboardData.reduce((acc, cur) => acc + cur.count, 0);

        res.json({ 
            success: true, 
            startDate: targetStartDate, // 프론트 표시용 시작일
            endDate: targetEndDate,     // 프론트 표시용 종료일 (선택일)
            totalCount: totalCount,
            data: dashboardData 
        });

    } catch (error) {
        console.error('대시보드 조회 오류:', error);
        res.status(500).json({ success: false, message: '대시보드 데이터 조회 오류' });
    }
});
// 4. [GET] 매장 리스트 조회 (드롭박스용)
app.get('/api/jwasu/stores', (req, res) => {
    res.json({ success: true, stores: OFFLINE_STORES });
});

// 5. [GET] 기간별/매장별 상세 집계표 조회 API (table.html용)
app.get('/api/jwasu/table', async (req, res) => {
    try {
        const { store, startDate, endDate } = req.query;

        // 1. 검색 조건 설정
        const query = {
            date: {
                $gte: startDate, // 시작일
                $lte: endDate    // 종료일
            }
        };

        // 전체가 아닐 경우 매장명 필터 추가
        if (store && store !== 'all') {
            query.storeName = store;
        }

        const collection = db.collection(jwasuCollectionName);

        // 2. 데이터 조회 및 정렬 (날짜 내림차순 -> 매장명 오름차순)
        const report = await collection.find(query)
            .sort({ date: -1, storeName: 1 })
            .toArray();

        res.json({ success: true, report });

    } catch (error) {
        console.error('집계표 조회 오류:', error);
        res.status(500).json({ success: false, message: '데이터 조회 실패' });
    }
});


// 6. [GET] 월별 좌수왕(명예의 전당) 히스토리 조회 API
app.get('/api/jwasu/monthly-history', async (req, res) => {
    try {
        const { month } = req.query; // 예: "2025-11"

        if (!month) {
            return res.status(400).json({ success: false, message: '월(month) 정보가 필요합니다.' });
        }

        // 1. 해당 월의 시작일(1일)과 마지막 날 계산
        const startOfMonth = moment(month).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = moment(month).endOf('month').format('YYYY-MM-DD');

        const collection = db.collection(jwasuCollectionName);

        // 2. 해당 기간 내 데이터 집계 (매장별 합산)
        const pipeline = [
            {
                $match: {
                    date: { $gte: startOfMonth, $lte: endOfMonth }
                }
            },
            {
                $group: {
                    _id: "$storeName",
                    totalCount: { $sum: "$count" }
                }
            }
        ];

        const aggResults = await collection.aggregate(pipeline).toArray();

        // 3. 결과를 Map으로 변환 (매장명 -> 카운트)
        const resultMap = {};
        aggResults.forEach(item => {
            resultMap[item._id] = item.totalCount;
        });

        // 4. 전체 매장 리스트 기준으로 데이터 포맷팅 (데이터 없으면 0)
        const historyData = OFFLINE_STORES.map(store => {
            return {
                storeName: store,
                count: resultMap[store] || 0,
                rank: 0
            };
        });

        // 5. 랭킹 산정 (내림차순)
        historyData.sort((a, b) => b.count - a.count);
        historyData.forEach((item, index) => {
            item.rank = index + 1;
        });

        res.json(historyData);

    } catch (error) {
        console.error('월별 기록 조회 오류:', error);
        res.status(500).json({ success: false, message: '월별 기록 조회 실패' });
    }
});

// 7. [GET] 특정 매장 내 통계 (이번 달 일별 내역만) 조회 API
app.get('/api/jwasu/my-stats', async (req, res) => {
    try {
        const { storeName } = req.query;
        if (!storeName) return res.status(400).json({ success: false, message: '매장명이 필요합니다.' });

        const now = moment().tz('Asia/Seoul');
        
        // 이번 달의 시작일(1일)과 마지막 날(말일) 계산
        const startOfThisMonth = now.clone().startOf('month').format('YYYY-MM-DD');
        const endOfThisMonth = now.clone().endOf('month').format('YYYY-MM-DD');

        const collection = db.collection(jwasuCollectionName);

        // [수정] 이번 달 일별 데이터만 조회 (최신순 정렬)
        const dailyRecords = await collection.find({
            storeName: storeName,
            date: { $gte: startOfThisMonth, $lte: endOfThisMonth }
        }).sort({ date: -1 }).toArray();

        res.json({
            success: true,
            data: dailyRecords // 일별 데이터만 반환
        });

    } catch (error) {
        console.error('내 통계 조회 오류:', error);
        res.status(500).json({ success: false, message: '통계 조회 실패' });
    }
});

// ==========================================
// [추가] 매장별 매출 목표 일괄 설정 API
// ==========================================
app.post('/api/jwasu/admin/store-target', async (req, res) => {
    try {
        const { month, storeName, targetMonthlySales, targetWeeklySales } = req.body;

        if (!month || !storeName) return res.status(400).json({ success: false, message: '정보가 부족합니다.' });

        // 1. 해당 월, 해당 매장의 '모든' 매니저 목표 데이터에서 매출 부분만 업데이트
        // (upsert: true를 쓰면 매니저가 없어도 데이터가 생길 수 있으므로, updateMany로 기존 데이터 수정)
        
        // 주간 데이터 포맷팅
        let weeklyData = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };
        if (targetWeeklySales) weeklyData = targetWeeklySales;

        // A. monthlyTargetCollection (목표 컬렉션) 업데이트
        await db.collection(monthlyTargetCollection).updateMany(
            { month: month, storeName: storeName },
            { 
                $set: { 
                    targetMonthlySales: parseInt(targetMonthlySales) || 0,
                    targetWeeklySales: weeklyData,
                    updatedAt: new Date()
                } 
            },
            { upsert: false } // 기존에 목표가 설정된 사람들의 매출만 업데이트
        );

        // B. (중요) 만약 매니저가 한 명도 없거나 목표가 설정된 적이 없는 경우를 대비해
        // '시스템 플레이스홀더(투명인간)'에게 매출 목표를 심어둠 (대시보드 표출용)
        await db.collection(monthlyTargetCollection).updateOne(
            { month: month, storeName: storeName, managerName: "system_store_placeholder" },
            { 
                $set: { 
                    targetMonthlySales: parseInt(targetMonthlySales) || 0,
                    targetWeeklySales: weeklyData,
                    updatedAt: new Date()
                } 
            },
            { upsert: true }
        );

        // C. 매니저 정보(jwasu_managers)의 기본 목표값도 업데이트 (선택 사항이지만 일관성을 위해)
        await db.collection(staffCollectionName).updateMany(
            { storeName: storeName },
            { 
                $set: { 
                    targetMonthlySales: parseInt(targetMonthlySales) || 0,
                    targetWeeklySales: weeklyData
                } 
            }
        );

        res.json({ success: true, message: '매장 매출 목표가 설정되었습니다.' });

    } catch (error) {
        console.error("매장 매출 목표 저장 오류:", error);
        res.status(500).json({ success: false, message: '서버 오류' });
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