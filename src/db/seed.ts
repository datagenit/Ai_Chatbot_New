import mongoose from "mongoose";
import connectDB from "./mongodb.js";
import AdminConfig from "../models/AdminConfig.js";

async function seed() {
  try {
    // Connect to MongoDB
    await connectDB();

    // Delete all existing AdminConfig documents
    await AdminConfig.deleteMany({});
    console.log("Cleared existing AdminConfig documents");

    // Insert Admin 1
    const admin1 = await AdminConfig.create({
      adminId: "6737",
      tools: {
        get_current_datetime: true,
        search_knowledge_base: true,
        search_web: true,
        create_ticket: true,
      },
      kb: {
        maxResults: 5,
      },
    });
    console.log("Inserted Admin 1:", JSON.stringify(admin1.toObject(), null, 2));

    // Insert Admin 2
    const admin2 = await AdminConfig.create({
      adminId: "admin2",
      tools: {
        get_current_datetime: false,
        search_knowledge_base: true,
        search_web: false,
        create_ticket: false,
      },
      kb: {
        maxResults: 3,
      },
    });
    console.log("Inserted Admin 2:", JSON.stringify(admin2.toObject(), null, 2));

    console.log("Seeding completed successfully");
  } catch (error) {
    console.error("Seeding error:", error);
    process.exit(1);
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

// Run the seed function
seed();
