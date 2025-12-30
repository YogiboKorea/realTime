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
app.use(cors());
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
const PORT = 8014; // 8014 포트로 통일

// --- 3. 전역 변수 및 .env 설정 ---

// Cafe24 API 및 랭킹 관련
let accessToken = 'B6sxr1WrHxujGvWbteE2JB'; 
let refreshToken = 'G9lX36tyIB8ne6WvVGLgjB'; 

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoUri = process.env.MONGO_URI; // .env에서 로드
const dbName = process.env.DB_NAME || 'yogibo'; // 없을 경우 기본값
const collectionName = process.env.COLLECTION_NAME; 
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


// MongoDB에서 토큰 읽기
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

// MongoDB에 토큰 저장
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
            await refreshAccessToken(); 
            return apiRequest(method, url, data, params); 
        } else {
            console.error('API 요청 오류:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}



// ==========================================
// [설정] 컬렉션 이름 정의
// ==========================================
const jwasuCollectionName = 'offline_jwasu';      // [좌수] 일별 카운트 기록
const staffCollectionName = 'jwasu_managers';     // [관리] 오프라인 매니저 정보
const monthlyTargetCollection = 'jwasu_monthly_targets'; // [NEW] 월별 목표 관리
const cafe24ManagerCollection = 'managers';       // [Legacy] Cafe24용 매니저
const managerSalesCollection = 'manager_salesNew';   // [NEW] 매니저별 매출 기록
const orderCollectionName = 'offline_orders';     // ★ [NEW] 오프라인 주문 내역 저장용 컬렉션

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

        // 목표 결정
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

        const normalize = (str) => String(str || '').replace(/\s+/g, '').trim();

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

        const monthlyTargets = await targetCollection.find({ month: targetMonthStr }).toArray();
        const monthlyTargetMap = {};
        monthlyTargets.forEach(t => {
            const key = `${normalize(t.storeName)}_${normalize(t.managerName)}`;
            monthlyTargetMap[key] = t;
        });

        const records = await collection.find({ 
            date: { $gte: targetStartDate, $lte: targetEndDate } 
        }).toArray();

        const aggregates = {};
        
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
            let joinDate = null;

            if (mTarget && mTarget.targetCount > 0) finalTarget = mTarget.targetCount;
            else if (record.targetCount > 0) finalTarget = record.targetCount;
            else if (info) finalTarget = info.targetCount;

            if (mTarget && mTarget.targetMonthlySales > 0) finalSales = mTarget.targetMonthlySales;
            else if (record.targetMonthlySales > 0) finalSales = record.targetMonthlySales;
            else if (info) finalSales = info.targetMonthlySales;

            if (mTarget && mTarget.targetWeeklySales) finalWeekly = mTarget.targetWeeklySales;
            else if (record.targetWeeklySales) finalWeekly = record.targetWeeklySales;
            else if (info && info.targetWeeklySales) finalWeekly = info.targetWeeklySales;

            if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
            else if (info && info.joinDate) joinDate = info.joinDate;

            if (!aggregates[uniqueKey]) {
                aggregates[uniqueKey] = { 
                    storeName: info ? info.storeName : record.storeName,
                    managerName: mgr,
                    role: record.role || (info ? info.role : '-'),
                    targetCount: finalTarget, 
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, 
                    joinDate: joinDate, 
                    count: 0, 
                    rank: 0,
                    rate: 0
                };
            } else {
                if (aggregates[uniqueKey].targetCount === 0 && finalTarget > 0) aggregates[uniqueKey].targetCount = finalTarget;
                if (aggregates[uniqueKey].targetMonthlySales === 0 && finalSales > 0) aggregates[uniqueKey].targetMonthlySales = finalSales;
                
                const currW = aggregates[uniqueKey].targetWeeklySales;
                if ((!currW || (currW.w1===0 && currW.w2===0)) && (finalWeekly.w1>0 || finalWeekly.w2>0)) {
                    aggregates[uniqueKey].targetWeeklySales = finalWeekly;
                }
                if (!aggregates[uniqueKey].joinDate && joinDate) {
                    aggregates[uniqueKey].joinDate = joinDate;
                }
            }
            
            aggregates[uniqueKey].count += record.count;
        });

        activeSet.forEach(key => {
            if (!aggregates[key]) {
                const info = staffMap[key];
                const mTarget = monthlyTargetMap[key];
                
                const finalTarget = (mTarget && mTarget.targetCount > 0) ? mTarget.targetCount : (info.targetCount || 0);
                const finalSales = (mTarget && mTarget.targetMonthlySales > 0) ? mTarget.targetMonthlySales : (info.targetMonthlySales || 0);
                const finalWeekly = (mTarget && mTarget.targetWeeklySales) ? mTarget.targetWeeklySales : (info.targetWeeklySales || { w1:0, w2:0, w3:0, w4:0, w5:0 });
                
                let joinDate = null;
                if (mTarget && mTarget.joinDate) joinDate = mTarget.joinDate;
                else if (info && info.joinDate) joinDate = info.joinDate;

                aggregates[key] = {
                    storeName: info.storeName,
                    managerName: info.managerName,
                    role: info.role || '-',
                    targetCount: finalTarget,
                    targetMonthlySales: finalSales,
                    targetWeeklySales: finalWeekly, 
                    joinDate: joinDate, 
                    count: 0,
                    rank: 0,
                    rate: 0
                };
            }
        });

        const dashboardData = Object.values(aggregates);

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

// [섹션 - 통합 조회] 테이블 API
app.get('/api/jwasu/table', async (req, res) => {
    try {
        const { store, startDate, endDate } = req.query;
        let query = {};
        
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        }
        
        if (store && store !== 'all') {
            query.storeName = store; 
        }

        const jwasuList = await db.collection(jwasuCollectionName)
                                  .find(query)
                                  .sort({ date: -1 })
                                  .toArray();

        const report = jwasuList.map(item => ({
            type: 'jwasu',
            date: item.date,
            storeName: item.storeName || '알수없음',
            managerName: item.managerName || '미지정',
            role: item.role || '-',
            count: item.count || 0,
            revenue: 0 
        }));
        
        res.status(200).json({ success: true, report: report });

    } catch (error) {
        console.error("좌수 테이블 조회 오류:", error);
        res.status(500).json({ success: false, message: '서버 내부 오류' });
    }
});

// ==========================================
// [섹션 G] 월별 목표 관리 API
// ==========================================

app.get('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        const { month, storeName, managerName } = req.query;
        if (!month || !storeName || !managerName) return res.status(400).json({ success: false });

        const target = await db.collection(monthlyTargetCollection).findOne({ month, storeName, managerName });
        res.json({ success: true, data: target || {} });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/jwasu/admin/monthly-target', async (req, res) => {
    try {
        const { 
            month, storeName, managerName, 
            targetCount, targetMonthlySales, targetWeeklySales, 
            w1, w2, w3, w4, w5, 
            joinDate 
        } = req.body;
        
        let weeklySalesData = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };

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
                    joinDate: joinDate || null, 
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

app.post('/api/jwasu/admin/manager', async (req, res) => {
    try {
        const { storeName, managerName, role, consignment, targetCount, targetMonthlySales, targetWeeklySales, isActive } = req.body;
        if (!storeName || !managerName) return res.status(400).json({ success: false });
        
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
        const { 
            storeName, managerName, role, consignment, 
            targetCount, targetMonthlySales, targetWeeklySales, 
            memo 
        } = req.body;

        await db.collection(staffCollectionName).updateOne(
            { _id: new ObjectId(id) },
            { 
                $set: { 
                    storeName, managerName, role, consignment, 
                    targetCount: parseInt(targetCount) || 0, 
                    targetMonthlySales: parseInt(targetMonthlySales) || 0, 
                    targetWeeklySales: parseInt(targetWeeklySales) || 0,
                    memo: memo, 
                    updatedAt: new Date() 
                } 
            }
        );
        res.json({ success: true });
    } catch (error) { 
        console.error("매니저 수정 오류:", error);
        res.status(500).json({ success: false }); 
    }
});

app.put('/api/jwasu/admin/manager/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body; 
        await db.collection(staffCollectionName).updateOne({ _id: new ObjectId(id) }, { $set: { isActive: isActive } });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/jwasu/admin/manager/:id', async (req, res) => {
    try {
        const { id } = req.params;
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

// [섹션 - 기타 통계] - my-stats
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

// [섹션 - 월별 히스토리] - monthly-history
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

// [섹션 F] 기존 좌수 엑셀 업로드
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


// [섹션 H] 매니저 매출 관리
app.get('/api/manager-sales', async (req, res) => {
    try {
        const { date, storeName } = req.query; 
        const query = {};
        
        if (date) query.date = date; 
        if (storeName) query.storeName = storeName;

        const collection = db.collection(managerSalesCollection);
        const results = await collection.find(query).sort({ date: -1, storeName: 1 }).toArray();

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('매니저 매출 조회 오류:', error);
        res.status(500).json({ success: false, message: '매출 데이터 조회 실패' });
    }
});

app.post('/api/manager-sales/upload-excel', async (req, res) => {
    try {
        const { data } = req.body; 
        
        if (!Array.isArray(data) || data.length === 0) {
            return res.status(400).json({ success: false, message: '데이터가 없습니다.' });
        }

        const collection = db.collection(managerSalesCollection);
        const bulkOps = [];

        data.forEach(item => {
            const dateStr = item.date; 
            const storeName = String(item.storeName || '').trim();
            const managerName = String(item.managerName || '미지정').trim();
            const salesAmount = parseInt(item.salesAmount) || 0; 
            
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
                        upsert: true 
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
// [API] Cafe24 상품 검색 (기존 유지)
// ==========================================
app.get('/api/cafe24/products', async (req, res) => {
    try {
        const { keyword } = req.query;

        if (!keyword) {
            return res.json({ success: true, count: 0, data: [] });
        }

        console.log(`[Cafe24] 검색 시작: "${keyword}"`);

        // 1. Cafe24 API 호출
        const response = await apiRequest(
            'GET',
            `https://${MALLID}.cafe24api.com/api/v2/admin/products`,
            null,
            {
                'shop_no': 1,
                'product_name': keyword,
                'display': 'T',
                'selling': 'T',
                'embed': 'options',      // ★ 옵션 포함 요청
                'fields': 'product_no,product_name,price,product_code,has_option,options',
                'limit': 50
            }
        );

        const products = response.products;

        // 3. 데이터 정제
        const cleanData = products.map(item => {
            let myOptions = [];
            let rawOptionList = [];

            if (item.options) {
                if (Array.isArray(item.options)) {
                    rawOptionList = item.options; 
                } else if (item.options.options && Array.isArray(item.options.options)) {
                    rawOptionList = item.options.options; 
                }
            }

            if (rawOptionList.length > 0) {
                
                // (A) '색상/Color/컬러' 이름이 있는 옵션을 찾음
                let targetOption = rawOptionList.find(opt => {
                    const name = (opt.option_name || "").toLowerCase();
                    return name.includes('색상') || name.includes('color') || name.includes('컬러');
                });

                // (B) 못 찾았으면, 그냥 첫 번째 옵션을 사용
                if (!targetOption && rawOptionList.length > 0) {
                    targetOption = rawOptionList[0];
                }

                // (C) 값 추출
                if (targetOption && targetOption.option_value) {
                    myOptions = targetOption.option_value.map(val => ({
                        option_code: val.value_no || val.value_code || val.value, 
                        option_name: val.value_name || val.option_text || val.name 
                    }));
                }
            }

            // 옵션이 비어있다면 로그
            if (myOptions.length === 0 && item.has_option === 'T') {
                console.log(`⚠️ [옵션추출실패] 상품명: ${item.product_name}, 구조확인필요`);
            }

            return {
                product_no: item.product_no,
                product_name: item.product_name,
                price: Math.floor(Number(item.price)),
                options: myOptions
            };
        });

        console.log(`[Cafe24] 검색 완료: ${cleanData.length}건 반환`);
        res.json({ success: true, count: cleanData.length, data: cleanData });

    } catch (error) {
        console.error('[Cafe24] API 오류:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '서버 오류 발생' });
    }
});

// ==========================================
// ★ [NEW] 오프라인 주문 API (MongoDB 연동)
// ==========================================

// 1. 주문 완료 (POST) - DB 저장
app.post('/api/orders', async (req, res) => {
    try {
        console.log('[API] 주문 요청 수신:', JSON.stringify(req.body, null, 2));

        const {
            product_no,
            product_name,
            selected_option,
            price,
            quantity,
            total_price,
            customer_name,
            customer_phone,
            address,
            manager_name,
            shipping_cost
        } = req.body;

        // 필수 데이터 검증
        if (!product_name || !customer_name) {
            return res.status(400).json({ success: false, message: '필수 정보 누락' });
        }

        // MongoDB에 저장할 데이터 객체 생성
        const orderData = {
            product_no,
            product_name,
            option_name: selected_option || '단일옵션',
            price: Number(price) || 0,
            quantity: Number(quantity) || 1,
            shipping_cost: Number(shipping_cost) || 0,
            total_amount: Number(total_price) || 0,
            customer_name,
            customer_phone,
            address,
            manager_name,
            created_at: new Date() // 날짜는 Date 객체로 저장
        };

        // DB 컬렉션에 삽입 (collectionName: offline_orders)
        const collection = db.collection(orderCollectionName);
        const result = await collection.insertOne(orderData);

        console.log('[DB] 주문 저장 완료. ID:', result.insertedId);

        res.json({ success: true, message: '주문이 등록되었습니다.', orderId: result.insertedId });

    } catch (error) {
        console.error('[에러] 주문 저장 실패:', error);
        res.status(500).json({ success: false, message: '서버 에러 발생', error: error.message });
    }
});

// 2. 주문 목록 조회 (GET) - 팝업용
app.get('/api/orders', async (req, res) => {
    try {
        const collection = db.collection(orderCollectionName);
        // 최근 주문 50개 조회 (최신순)
        const orders = await collection.find({})
            .sort({ created_at: -1 })
            .limit(50)
            .toArray();

        res.json({ success: true, data: orders });

    } catch (error) {
        console.error('[에러] 주문 목록 조회 실패:', error);
        res.status(500).json({ success: false, message: '조회 실패' });
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

        });
    })
    .catch(err => {
        console.error('MongoDB 연결 실패:', err);
        process.exit(1); // MongoDB 연결 실패 시 서버 종료
    });