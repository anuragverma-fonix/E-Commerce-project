const sharp = require("sharp");
const fs = require("fs");

// Custom blur detection using Sharp with improved Laplacian variance method
const detectBlurWithSharp = async (imagePath) => {
  try {
    // Convert to grayscale and apply Laplacian operator for edge detection
    const { data, info } = await sharp(imagePath)
      .greyscale()
      .resize(300, 300, { fit: 'inside' })
      .convolve({
        width: 3,
        height: 3,
        kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0], // Laplacian kernel for edge detection
        offset: 128
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Calculate variance of the edge-detected image (Laplacian variance)
    const pixels = new Uint8Array(data);
    let sum = 0;
    let sumSquared = 0;
    
    for (let i = 0; i < pixels.length; i++) {
      sum += pixels[i];
      sumSquared += pixels[i] * pixels[i];
    }
    
    const mean = sum / pixels.length;
    const laplacianVariance = (sumSquared / pixels.length) - (mean * mean);
    
    // Threshold for blur detection (lower Laplacian variance = blurrier image)
    const blurThreshold = BLUR_THRESHOLD;
    const isBlurry = laplacianVariance < blurThreshold;
    
    console.log(`🔍 Blur Analysis - Laplacian Variance: ${laplacianVariance.toFixed(2)}, Threshold: ${blurThreshold}, Is Blurry: ${isBlurry}`);
    
    return isBlurry;
  } catch (error) {
    console.warn('Blur detection failed:', error.message);
    return false; // If detection fails, assume image is not blurry
  }
};

const MIN_WIDTH = 0;
const MIN_HEIGHT = 0;
const MAX_WIDTH = 2000;
const MAX_HEIGHT = 2000;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const BLUR_THRESHOLD = 1000; // Lower values = more strict blur detection (500-2000 is a good range for Laplacian variance)
const ENABLE_BLUR_DETECTION = true; // Set to false to disable blur checking

const checkImageQuality = async (req, res, next) => {
  console.log("🔍 checkImageQuality middleware started");
  console.log("Request files:", req.files ? Object.keys(req.files) : "No req.files");
  console.log("Request file:", req.file ? req.file.fieldname : "No req.file");
  
  try {
    // Handle both single file (req.file) and multiple files (req.files)
    let filesToCheck = [];
    
    if (req.file) {
      // Single file upload
      filesToCheck = [req.file];
    } else if (req.files) {
      // Multiple files upload - flatten all files from different fields
      filesToCheck = Object.values(req.files).flat();
    }
    
    if (filesToCheck.length === 0) {
      console.log("No files to check, proceeding...");
      return next(); // No files uploaded
    }

    console.log(`Checking ${filesToCheck.length} file(s) for quality...`);

    // Process each file with better error handling
    for (const file of filesToCheck) {
      console.log(`Processing file: ${file.fieldname} - ${file.originalname}`);
      
      try {
        // 1. Check MIME type
        if (!ALLOWED_TYPES.includes(file.mimetype)) {
          console.log(`❌ Invalid file type: ${file.mimetype} for ${file.fieldname}`);
          await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete file:", err));
          return res.status(400).json({
            success: false,
            message: `Invalid file type for ${file.fieldname}: ${file.mimetype}. Only JPEG, PNG, WebP, and GIF allowed.`,
          });
        }

        // 2. Check for blurriness using custom Sharp-based detection
        if (ENABLE_BLUR_DETECTION) {
          console.log(`📷 Checking blur for: ${file.fieldname}`);
          try {
            const isBlurry = await detectBlurWithSharp(file.path);
            if (isBlurry) {
              console.log(`❌ Image is too blurry: ${file.fieldname}`);
              await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete file:", err));
              return res.status(400).json({
                success: false,
                message: `Image is too blurry: ${file.fieldname}. Please upload a clearer, sharper image.`,
              });
            }
            console.log(`✅ Blur check passed for: ${file.fieldname}`);
          } catch (blurError) {
            console.warn(`⚠️ Blur detection failed for ${file.fieldname}, continuing:`, blurError.message);
            // Continue without failing the upload if blur detection fails
          }
        } else {
          console.log(`⏸️ Blur detection disabled for: ${file.fieldname}`);
        }

        // 3. Get metadata with error handling
        let metadata;
        try {
          metadata = await sharp(file.path).metadata();
        } catch (sharpError) {
          console.error(`Sharp metadata error for ${file.fieldname}:`, sharpError.message);
          await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete file:", err));
          return res.status(400).json({
            success: false,
            message: `Failed to process image: ${file.fieldname}. File may be corrupted.`,
          });
        }

        if (metadata.width < MIN_WIDTH || metadata.height < MIN_HEIGHT) {
          console.log(`❌ Resolution too low: ${metadata.width}x${metadata.height} for ${file.fieldname}`);
          await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete file:", err));
          return res.status(400).json({
            success: false,
            message: `Image resolution too low for ${file.fieldname}. Minimum ${MIN_WIDTH}x${MIN_HEIGHT}px required.`,
          });
        }

        // 4. Optional: Resize large images
        if (metadata.width > MAX_WIDTH || metadata.height > MAX_HEIGHT) {
          console.log(`Resizing large image: ${file.fieldname} from ${metadata.width}x${metadata.height}`);
          try {
            await sharp(file.path)
              .resize({
                width: MAX_WIDTH,
                height: MAX_HEIGHT,
                fit: "inside",
                withoutEnlargement: true,
              })
              .toFile(file.path + "-resized");

            await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete original file:", err));
            await fs.promises.rename(file.path + "-resized", file.path).catch(err => console.warn("Failed to rename file:", err));
            console.log(`✅ Image resized successfully: ${file.fieldname}`);
          } catch (resizeError) {
            console.error(`Resize error for ${file.fieldname}:`, resizeError.message);
            // Continue even if resize fails
          }
        }

        console.log(`✅ Image passed quality checks: ${file.fieldname}`, {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          size: file.size,
        });
      } catch (fileError) {
        console.error(`Error processing file ${file.fieldname}:`, fileError.message);
        // Try to clean up the file
        await fs.promises.unlink(file.path).catch(err => console.warn("Failed to delete file:", err));
        return res.status(500).json({
          success: false,
          message: `Error processing file: ${file.fieldname}`,
          error: fileError.message
        });
      }
    }
    
    console.log("✅ All images passed quality checks, proceeding to controller...");
    next();
  } catch (err) {
    console.error("❌ Image processing middleware error:", err);
    return res.status(500).json({
      success: false,
      message: "Error in image quality checker middleware.",
      error: err.message
    });
  }
};

module.exports = { checkImageQuality };