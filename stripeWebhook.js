const Stripe = require("stripe");
const mongoose = require("mongoose");
const Transaction = require("./models/transaction");
const Order = require("./models/order");
const Product = require("./models/product");
require("dotenv").config();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const stripeWebhook = async (req, res) => {

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;

  try {

    switch (event.type) {
      
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        // Find transaction
        const transaction = await Transaction.findOne({ transactionId: session.id });
        if (!transaction) {
          console.warn("Transaction not found for session:", session.id);
          break;
        }

        // Start a Mongoose session for atomic updates
        const dbSession = await mongoose.startSession();
        dbSession.startTransaction();
        try {
          // Update transaction status
          transaction.status = "Completed";
          await transaction.save({ session: dbSession });

          // Update order status and payment
          const order = await Order.findByIdAndUpdate(
            transaction.order,
            { payment_status: "Completed", status: "Processing" },
            { new: true, session: dbSession }
          ).populate("products.product");

          // Reduce stock
          if (order?.products?.length) {
            for (const item of order.products) {
              const product = await Product.findById(item.product._id).session(dbSession);
              if (!product) continue;
              product.quantity = Math.max(product.quantity - item.quantity, 0);
              await product.save({ session: dbSession });
            }
          }

          await dbSession.commitTransaction();
          dbSession.endSession();

          console.log("Payment completed and stock updated for order:", order._id);
        } catch (err) {
          await dbSession.abortTransaction();
          dbSession.endSession();
          console.error("Error updating order/stock:", err);
        }

        break;
      }

      case "checkout.session.async_payment_failed": {
        const transaction = await Transaction.findOne({ transactionId: session.id });
        if (transaction) {
          transaction.status = "Failed";
          await transaction.save();
          await Order.findByIdAndUpdate(transaction.order, { payment_status: "Failed" });
          console.log("Async payment failed for transaction:", transaction._id);
        }
        break;
      }

      case "checkout.session.expired": {
        const transaction = await Transaction.findOne({ transactionId: session.id });
        if (transaction) {
          transaction.status = "Expired";
          await transaction.save();
          await Order.findByIdAndUpdate(transaction.order, { payment_status: "Expired" });
          console.log("⚠️ Checkout session expired for transaction:", transaction._id);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).send(`Webhook Error: ${err.message}`);
  }
};

module.exports = {
  stripeWebhook,
};