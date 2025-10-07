const Stripe = require("stripe");
const Product = require("../../models/product");
const Order = require("../../models/order");
const Transaction = require("../../models/transaction");
const { response } = require("../../utils/response");
require("dotenv").config();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const createCheckoutSession = async (req, res) => {

  try{

    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: "Order ID is required" });
    }

    const order = await Order.findById(orderId).populate("products.product");
    const userId = order.user;
    const totalAmount = order.total_price;

    // Calculate line items for Stripe
    const lineItems = order.products.map((item) => ({
      price_data: {
        currency: "inr",
        product_data: {
          name: item.product.name,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    // Add GST as a separate line item
    if (order.gst_charge && order.gst_charge > 0) {
      lineItems.push({
        price_data: {
          currency: "inr",
          product_data: {
            name: "GST (18%)",
          },
          unit_amount: Math.round(order.gst_charge * 100),
        },
        quantity: 1,
      });
    }

    // Add Shipping as a separate line item
    if (order.shipping_charge && order.shipping_charge > 0) {
      lineItems.push({
        price_data: {
          currency: "inr",
          product_data: {
            name: "Shipping Charge",
          },
          unit_amount: Math.round(order.shipping_charge * 100),
        },
        quantity: 1,
      });
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancelled`,
      metadata: {
        orderId: order._id.toString(),
      },
    });

    //Save transaction
    const transaction = await Transaction.create({
      order: order._id,
      user: userId,
      amount: totalAmount,
      status: "Pending",
      transactionId: session.id,
    });

    order.transaction = transaction._id;
    await order.save();

    return response(res, 200, "Checkout session created successfully", {
      id: session.id,
      url: session.url,
    });

  }catch(error){
    console.error("Stripe Error:", error);
    res.status(500).json({ message: "Server error", error });
  }

};

module.exports = {
  createCheckoutSession
}