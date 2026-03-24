import mongoose, { Schema } from 'mongoose';

const sessionSchema = new Schema(
    {
        sessionId: { type: String, required: true, unique: true, index: true },
        runMode: { type: String, enum: ['live', 'dryrun'], required: true },
        startedAt: { type: Date, required: true },
        endedAt: { type: Date },
        proxyWallet: { type: String, required: true },
        traderAddresses: { type: [String], default: [] },
    },
    { collection: 'copy_tracking_sessions' }
);

const entrySchema = new Schema(
    {
        sessionId: { type: String, required: true, index: true },
        runMode: { type: String, enum: ['live', 'dryrun'], required: true },
        createdAt: { type: Date, required: true, default: Date.now },
        traderAddress: { type: String, required: true, index: true },
        traderDisplayName: { type: String },
        marketTitle: { type: String },
        slug: { type: String },
        conditionId: { type: String, index: true },
        copyMode: { type: String, enum: ['FOLLOW', 'REVERSE'], required: true },
        traderSide: { type: String, enum: ['BUY', 'SELL'], required: true },
        mySide: { type: String, enum: ['BUY', 'SELL'], required: true },
        traderOutcome: { type: String },
        myOutcome: { type: String },
        traderAsset: { type: String },
        myTradedAsset: { type: String, required: true },
        executedUsdc: { type: Number, required: true },
        myTokenDelta: { type: Number, required: true },
        traderTxHash: { type: String },
        activityObjectId: { type: String },
        realizedPnlUsd: { type: Number },
        autoExitType: { type: String },
        autoExitReason: { type: String },
        autoExitPercentPnl: { type: Number },
    },
    { collection: 'copy_tracking_entries' }
);

export const CopyTrackingSessionModel =
    mongoose.models.CopyTrackingSession ||
    mongoose.model('CopyTrackingSession', sessionSchema);

export const CopyTrackingEntryModel =
    mongoose.models.CopyTrackingEntry || mongoose.model('CopyTrackingEntry', entrySchema);
