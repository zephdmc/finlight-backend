const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body for custom validation rules
const { body } = require('express-validator');

// All routes require authentication
router.use(protect);

/**
 * @route   POST /api/payments/initialize
 * @desc    Initialize a payment with Paystack
 * @access  Private
 */
router.post(
  '/initialize',
  ValidationMiddleware.payment.initialize,
  paymentController.initializePayment
);

// @route   POST /api/payments/admin-direct
// @desc    Create direct payment (Admin only - no Paystack)
// @access  Private/Admin
router.post(
    '/admin-direct',
    roleCheck('admin'),
    paymentController.createAdminDirectPayment
  );

/**
 * @route   GET /api/payments/pending
 * @desc    Get user's pending payments (payment types not yet paid)
 * @access  Private
 */
router.get(
  '/pending',
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getPendingPayments(req.user.id);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/verify/:reference
 * @desc    Verify payment status
 * @access  Private
 */
router.get(
  '/verify/:reference',
  ValidationMiddleware.payment.verify,
  paymentController.verifyPayment
);

/**
 * @route   GET /api/payments
 * @desc    Get current user's payments
 * @access  Private
 */
router.get(
  '/',
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getUserPayments(req.user.id, req.query);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/outstanding
 * @desc    Get user's outstanding payments
 * @access  Private
 */
router.get(
  '/outstanding',
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getOutstandingPayments(req.user.id);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/payments
 * @desc    Create a new payment (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/',
  roleCheck('admin'),
  ValidationMiddleware.payment.create,
  paymentController.createPayment
);

/**
 * @route   POST /api/payments/bulk
 * @desc    Create multiple payments (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/bulk',
  roleCheck('admin'),
  [
    body('payments')
      .isArray()
      .withMessage('Payments must be an array')
      .notEmpty()
      .withMessage('Payments array cannot be empty'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.processBulkPayments(req.body.payments);
      
      res.status(201).json({
        success: true,
        data: result,
        message: `Processed ${result.successful.length} successful, ${result.failed.length} failed`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/all
 * @desc    Get all payments (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/all',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getAllPayments(req.query);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/summary
 * @desc    Get payment summary for reporting (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/summary',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getPaymentSummary(req.query);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/:id
 * @desc    Get single payment by ID
 * @access  Private
 */
router.get(
  '/:id',
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const payment = await Payment.findById(req.params.id)
        .populate('user', 'name email');
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      // Check authorization
      if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this payment'
        });
      }
      
      res.status(200).json({
        success: true,
        data: payment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /api/payments/:id
 * @desc    Update payment (Admin only)
 * @access  Private/Admin
 */
router.put(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  [
    body('amount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0'),
    body('dueDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const { amount, dueDate, description } = req.body;
      
      const payment = await Payment.findById(req.params.id);
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      if (payment.status === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Cannot update a paid payment'
        });
      }
      
      if (amount) payment.amount = amount;
      if (dueDate) payment.dueDate = dueDate;
      if (description) payment.description = description;
      
      await payment.save();
      
      res.status(200).json({
        success: true,
        data: payment,
        message: 'Payment updated successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /api/payments/:id
 * @desc    Delete payment (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const payment = await Payment.findById(req.params.id);
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      if (payment.status === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete a paid payment'
        });
      }
      
      await payment.deleteOne();
      
      res.status(200).json({
        success: true,
        message: 'Payment deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/payments/webhook/paystack
 * @desc    Paystack webhook handler
 * @access  Public (but should verify signature)
 */
router.post(
  '/webhook/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const paystackConfig = require('../config/paystack');
      const signature = req.headers['x-paystack-signature'];
      const payload = JSON.stringify(req.body);
      
      // Verify webhook signature
      if (!paystackConfig.verifyWebhookSignature(signature, payload)) {
        return res.status(401).json({
          success: false,
          message: 'Invalid webhook signature'
        });
      }
      
      const paymentService = require('../services/paymentService');
      await paymentService.handleWebhook(req.body);
      
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;