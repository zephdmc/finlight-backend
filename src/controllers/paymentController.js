const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const paystackService = require('../services/paystackService');
const TransactionController = require('./transactionController');
const PaymentType = require('../models/PaymentType')

// @desc    Initialize payment
// @route   POST /api/payments/initialize
// @access  Private
exports.initializePayment = async (req, res, next) => {
  try {
    const { paymentId } = req.body;
    
    const payment = await Payment.findById(paymentId).populate('user', 'name email');
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    if (payment.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already completed'
      });
    }
    
    const paymentData = {
      email: payment.user.email,
      amount: payment.amount * 100, // Paystack uses kobo
      reference: `PAY-${payment._id}-${Date.now()}`,
      metadata: {
        paymentId: payment._id,
        userId: payment.user._id,
        type: payment.type
      }
    };
    
    const response = await paystackService.initializePayment(paymentData);
    
    payment.transactionReference = paymentData.reference;
    await payment.save();
    
    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: response.data.authorization_url,
        reference: paymentData.reference
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create direct payment (Admin only - no Paystack)
 * @route   POST /api/payments/admin-direct
 * @access  Private/Admin
 */
exports.createAdminDirectPayment = async (req, res, next) => {
    try {
      const { userId, type, amount, dueDate, description, paymentTypeId, paidAt } = req.body;
      
      console.log('Admin direct payment request:', req.body);
      
      // Validate required fields
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required'
        });
      }
      
      if (!type) {
        return res.status(400).json({
          success: false,
          message: 'Payment type is required'
        });
      }
      
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid amount is required'
        });
      }
      
      // CHECK IF PAYMENT ALREADY EXISTS FOR THIS USER AND TYPE
      const existingPayment = await Payment.findOne({
        user: userId,
        paymentTypeId: paymentTypeId,
        status: 'paid'
      });
      
      if (existingPayment) {
        return res.status(400).json({
          success: false,
          message: `Payment already exists for this member. ${type} payment has already been made.`,
          data: {
            existingPayment: {
              id: existingPayment._id,
              type: existingPayment.type,
              amount: existingPayment.amount,
              paidAt: existingPayment.paidAt,
              transactionReference: existingPayment.transactionReference
            }
          }
        });
      }
      
      // Create payment with 'paid' status directly
      const payment = await Payment.create({
        user: userId,
        type: type,
        amount: amount,
        dueDate: dueDate || null,
        description: description || `${type} payment recorded by admin`,
        paymentTypeId: paymentTypeId || null,
        status: 'paid',
        paidAt: paidAt || new Date(),
        transactionReference: `ADMIN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      });
      
      // Populate user info
      await payment.populate('user', 'name email');
      
      // Update user's registration status if this is a registration payment
      if (type === 'registration') {
        const User = require('../models/User');
        await User.findByIdAndUpdate(userId, { hasPaidRegistration: true });
      }
      
      // Record as income (optional)
      try {
        const TransactionController = require('./transactionController');
        if (TransactionController.recordIncomeFromPayment) {
          await TransactionController.recordIncomeFromPayment({
            paymentId: payment._id,
            amount: payment.amount,
            type: payment.type,
            userId: payment.user,
            paymentTypeId: payment.paymentTypeId,
            description: payment.description
          });
        }
      } catch (incomeError) {
        console.error('Failed to record income from admin payment:', incomeError);
      }
      
      res.status(201).json({
        success: true,
        data: payment,
        message: `Payment of ₦${amount.toLocaleString()} recorded successfully for ${payment.user?.name || 'member'}`
      });
    } catch (error) {
      console.error('Admin direct payment error:', error);
      next(error);
    }
};

// @desc    Verify payment
// @route   GET /api/payments/verify/:reference
// @access  Private
exports.verifyPayment = async (req, res, next) => {
  try {
    const { reference } = req.params;
    
    const verification = await paystackService.verifyPayment(reference);
    
    if (verification.data.status === 'success') {
      const payment = await Payment.findOne({ transactionReference: reference });
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      // Update payment status
      payment.status = 'paid';
      payment.paidAt = new Date();
      await payment.save();
      
      // If registration payment, update user
      if (payment.type === 'registration') {
        await User.findByIdAndUpdate(payment.user, {
          hasPaidRegistration: true
        });
      }
      
      // Record as income using the TransactionController
      try {
        await TransactionController.recordIncomeFromPayment({
          paymentId: payment._id,
          amount: payment.amount,
          type: payment.type,
          userId: payment.user,
          paymentTypeId: payment.paymentTypeId,
          description: payment.description
        });
        
        console.log(`Income recorded successfully for payment: ${payment._id}`);
      } catch (incomeError) {
        // Log error but don't fail the verification
        console.error('Failed to record income from payment:', incomeError);
        // You might want to queue this for retry or log to a error collection
      }
      
      res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        data: payment
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Payment verification failed'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Create payment (Admin)
// @route   POST /api/payments
// @access  Private/Admin
exports.createPayment = async (req, res, next) => {
  try {
    const { userId, type, amount, dueDate, description, paymentTypeId } = req.body;
    
    const payment = await Payment.create({
      user: userId,
      type,
      amount,
      dueDate,
      description,
      paymentTypeId,
      status: 'unpaid'
    });
    
    res.status(201).json({
      success: true,
      data: payment,
      message: 'Payment created successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user payments
// @route   GET /api/payments
// @access  Private
exports.getUserPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find({ user: req.user.id })
      .populate('user', 'name email')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      data: payments
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all payments (Admin)
// @route   GET /api/payments/all
// @access  Private/Admin
exports.getAllPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find()
      .populate('user', 'name email')
      .populate('paymentTypeId', 'name description')
      .sort({ createdAt: -1 });
    
    // Get summary statistics
    const summary = {
      total: payments.length,
      totalAmount: payments.reduce((sum, p) => sum + p.amount, 0),
      paid: payments.filter(p => p.status === 'paid').length,
      unpaid: payments.filter(p => p.status === 'unpaid').length,
      totalPaidAmount: payments
        .filter(p => p.status === 'paid')
        .reduce((sum, p) => sum + p.amount, 0),
      totalUnpaidAmount: payments
        .filter(p => p.status === 'unpaid')
        .reduce((sum, p) => sum + p.amount, 0)
    };
    
    res.status(200).json({
      success: true,
      data: payments,
      summary
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payment
// @route   GET /api/payments/:id
// @access  Private
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('user', 'name email phone')
      .populate('paymentTypeId', 'name description amount');
    
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
};

// @desc    Update payment (Admin)
// @route   PUT /api/payments/:id
// @access  Private/Admin
exports.updatePayment = async (req, res, next) => {
  try {
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
};

// @desc    Delete payment (Admin)
// @route   DELETE /api/payments/:id
// @access  Private/Admin
exports.deletePayment = async (req, res, next) => {
  try {
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
};

/**
 * Get pending payments for a member
 * @route GET /api/payments/pending
 * @access Private
 */
exports.getPendingPayments = async (req, res, next) => {
    try {
      const userId = req.user.id;
      
      // Get all payment types
      const paymentTypes = await PaymentType.find({ isActive: true });
      
      // Get existing payments for this user
      const existingPayments = await Payment.find({ 
        user: userId,
        status: 'paid'
      });
      
      // Get payment type IDs that the user has already paid
      const paidTypeIds = existingPayments.map(p => p.paymentType?.toString());
      
      // Filter out payment types that have already been paid
      const pendingPaymentTypes = paymentTypes.filter(
        type => !paidTypeIds.includes(type._id.toString())
      );
      
      // Create payment records for pending types (optional - you can just return the types)
      const pendingPayments = pendingPaymentTypes.map(type => ({
        _id: type._id,
        name: type.name,
        description: type.description,
        amount: type.amount,
        type: type.type,
        isMandatory: type.isMandatory,
        status: 'pending'
      }));
      
      res.status(200).json({
        success: true,
        data: {
          records: pendingPayments,
          total: pendingPayments.length
        }
      });
    } catch (error) {
      next(error);
    }
  }

// @desc    Get payment statistics (Admin)
// @route   GET /api/payments/stats
// @access  Private/Admin
exports.getPaymentStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const [stats, paymentsByType, recentPayments] = await Promise.all([
      Payment.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: null,
            totalPayments: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            unpaidCount: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, 1, 0] } },
            paidAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
            unpaidAmount: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, '$amount', 0] } }
          }
        }
      ]),
      Payment.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ]),
      Payment.find(dateFilter)
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .limit(10)
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        summary: stats[0] || {
          totalPayments: 0,
          totalAmount: 0,
          paidCount: 0,
          unpaidCount: 0,
          paidAmount: 0,
          unpaidAmount: 0
        },
        byType: paymentsByType,
        recentPayments
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Webhook for Paystack
// @route   POST /api/payments/webhook
// @access  Public
exports.handleWebhook = async (req, res, next) => {
  try {
    const event = req.body;
    
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }
    
    if (event.event === 'charge.success') {
      const { reference } = event.data;
      
      const payment = await Payment.findOne({ transactionReference: reference });
      
      if (payment && payment.status !== 'paid') {
        payment.status = 'paid';
        payment.paidAt = new Date();
        await payment.save();
        
        // If registration payment, update user
        if (payment.type === 'registration') {
          await User.findByIdAndUpdate(payment.user, {
            hasPaidRegistration: true
          });
        }
        
        // Record as income
        try {
          await TransactionController.recordIncomeFromPayment({
            paymentId: payment._id,
            amount: payment.amount,
            type: payment.type,
            userId: payment.user,
            paymentTypeId: payment.paymentTypeId,
            description: payment.description
          });
        } catch (incomeError) {
          console.error('Failed to record income from webhook payment:', incomeError);
        }
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};