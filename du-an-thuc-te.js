// ==================================================================================
// MODIS LST Gap-filling Script for Vietnam
// ==================================================================================

// ----------------------------------------------------------------------------------
// Section 0: Script Configuration
// ----------------------------------------------------------------------------------

// Define the time period for LST data processing.
var startDate = ee.Date('2020-01-01');
var endDate = ee.Date('2020-02-01');

// Define the specific date range for displaying results on the map and exporting single-day examples.
var displayStart = startDate; // Typically the beginning of the overall period
var displayEnd = displayStart.advance(1, 'day'); // For a single day

// ----------------------------------------------------------------------------------
// Section 1: Study Area Definition
// ----------------------------------------------------------------------------------

// Load the FeatureCollection representing the boundary of Vietnam.
var viet_nam = ee.FeatureCollection("projects/ee-bonglantrungmuoi/assets/viet_nam");

// ----------------------------------------------------------------------------------
// Section 2: MODIS LST Data Ingestion
// ----------------------------------------------------------------------------------

// Load MODIS Terra LST daily 1km data (MOD11A1 V6).
var modisTerra = ee.ImageCollection('MODIS/006/MOD11A1')
    .filterDate(startDate, endDate)
    .filterBounds(viet_nam)
    .select(['LST_Day_1km', 'LST_Night_1km', 'QC_Day', 'QC_Night']);

// Load MODIS Aqua LST daily 1km data (MYD11A1 V6).
var modisAqua = ee.ImageCollection('MODIS/006/MYD11A1')
    .filterDate(startDate, endDate)
    .filterBounds(viet_nam)
    .select(['LST_Day_1km', 'LST_Night_1km', 'QC_Day', 'QC_Night']);

// ----------------------------------------------------------------------------------
// Section 3: Data Quality Filtering
// ----------------------------------------------------------------------------------

// Function to filter LST pixels based on QC flags.
// Pixels with QC flags indicating "pixel not produced due to cloud or other reasons" (binary XX11) are masked.
function filterQuality(image) {
    var qcDay = image.select('QC_Day');
    var qcNight = image.select('QC_Night');
    // Good quality pixels are those where the first two bits (0 and 1) are NOT both 1.
    var qualityMaskDay = qcDay.bitwiseAnd(3).neq(3);
    var qualityMaskNight = qcNight.bitwiseAnd(3).neq(3);
    return image.addBands(image.select('LST_Day_1km').updateMask(qualityMaskDay).rename('filtered_LST_Day_1km'))
        .addBands(image.select('LST_Night_1km').updateMask(qualityMaskNight).rename('filtered_LST_Night_1km'));
}

// Apply the quality filter to both Terra and Aqua collections.
var modisTerraFiltered = modisTerra.map(filterQuality);
var modisAquaFiltered = modisAqua.map(filterQuality);

// ----------------------------------------------------------------------------------
// Section 4: Combine Terra and Aqua Data
// ----------------------------------------------------------------------------------

// Merge the quality-filtered Terra and Aqua LST image collections.
// This increases data availability by combining observations from both satellites.
var combined = modisTerraFiltered.merge(modisAquaFiltered);

// ----------------------------------------------------------------------------------
// Section 5: Unit Conversion to Celsius
// ----------------------------------------------------------------------------------

// Convert LST values from Digital Numbers (scaled Kelvin) to Celsius.
// Formula: Celsius = (DN * 0.02) - 273.15
// The 'system:time_start' property is preserved for each image.

// Process combined day LST data.
var dayData = combined.select('filtered_LST_Day_1km').map(function (img) {
    return img.multiply(0.02).subtract(273.15)
        .rename('LST_Day_C')
        .set('system:time_start', img.get('system:time_start'));
});

// Process combined night LST data.
var nightData = combined.select('filtered_LST_Night_1km').map(function (img) {
    return img.multiply(0.02).subtract(273.15)
        .rename('LST_Night_C')
        .set('system:time_start', img.get('system:time_start'));
});

// ----------------------------------------------------------------------------------
// Section 6: Long-Term Mean (LTM) Calculation
// ----------------------------------------------------------------------------------

// Calculate the per-pixel long-term mean LST for the entire study period.
var meanDay = dayData.mean();
var meanNight = nightData.mean();

// ----------------------------------------------------------------------------------
// Section 7: Residual Calculation
// ----------------------------------------------------------------------------------

// Calculate LST residuals by subtracting the LTM from each daily LST image.
// Residuals represent deviations from the typical LST, helping to normalize the data.
var residualsDay = dayData.map(function (img) {
    return img.subtract(meanDay).rename('residual_day')
        .set('system:time_start', img.get('system:time_start'));
});
var residualsNight = nightData.map(function (img) {
    return img.subtract(meanNight).rename('residual_night')
        .set('system:time_start', img.get('system:time_start'));
});

// ----------------------------------------------------------------------------------
// Section 8: Spatial Smoothing of Residuals
// ----------------------------------------------------------------------------------

// Apply a double focal mean filter (3x3 pixel window) to smooth the LST residuals.
// This reduces noise and prepares residuals for more robust gap-filling.
var smoothedResidualsDay = residualsDay.map(function (img) {
    return img.focal_mean({ radius: 3, units: 'pixels' }).focal_mean({ radius: 3, units: 'pixels' })
        .set('system:time_start', img.get('system:time_start'));
});
var smoothedResidualsNight = residualsNight.map(function (img) {
    return img.focal_mean({ radius: 3, units: 'pixels' }).focal_mean({ radius: 3, units: 'pixels' })
        .set('system:time_start', img.get('system:time_start'));
});

// ----------------------------------------------------------------------------------
// Section 9: Gap-filling Function Definition
// ----------------------------------------------------------------------------------

// Custom function to fill gaps in an LST residual image for a target date.
function gapFillImage(collection, date) {
    var windowSize = 16; // Days before and after the target date to consider.

    // Create a temporal window of +/- windowSize days around the target date.
    var before = collection.filterDate(date.advance(-windowSize, 'day'), date);
    var after = collection.filterDate(date, date.advance(windowSize, 'day'));
    var window = before.merge(after); // Images within the 32-day window (excluding target date if it has data).

    // Perform temporal interpolation: calculate the mean of residuals within the window.
    var temporalMean = window.mean();
    var count = window.count();
    var reliable = count.gte(3); // Only consider pixels with at least 3 valid observations in the window.
    var temporallyFilled = temporalMean.updateMask(reliable);

    // Perform additional spatial smoothing on the temporally filled data.
    // This helps to fill smaller remaining gaps and smooth the field.
    var spatiallySmoothed = temporallyFilled
        .focal_mean({ radius: 3, units: 'pixels' })
        .focal_mean({ radius: 3, units: 'pixels' });

    // Get the original image for the target date (if it exists).
    var original = collection.filterDate(date, date.advance(1, 'day')).first();

    // Combine the original image with the spatially smoothed, temporally interpolated data.
    // Original pixel values are prioritized; gaps in the original are filled by the smoothed data.
    return ee.Image(original).unmask(spatiallySmoothed)
        .set('system:time_start', date.millis());
}

// ----------------------------------------------------------------------------------
// Section 10: Date List Generation for Gap-filling
// ----------------------------------------------------------------------------------

// Create a list of all dates within the study period to iterate over for gap-filling.
var days = ee.List.sequence(0, endDate.difference(startDate, 'day').subtract(1));
var dates = days.map(function (d) {
    return startDate.advance(ee.Number(d), 'day');
});

// ----------------------------------------------------------------------------------
// Section 11: Apply Gap-filling to Create Filled Residual Collections
// ----------------------------------------------------------------------------------

// Apply the gapFillImage function to each date in the smoothed residual collections.
var filledResidualsDay = ee.ImageCollection.fromImages(
    dates.map(function (d) {
        return gapFillImage(smoothedResidualsDay, ee.Date(d));
    })
);
var filledResidualsNight = ee.ImageCollection.fromImages(
    dates.map(function (d) {
        return gapFillImage(smoothedResidualsNight, ee.Date(d));
    })
);

// ----------------------------------------------------------------------------------
// Section 12: Reconstruct Final LST from Filled Residuals and LTM
// ----------------------------------------------------------------------------------

// Add the long-term mean (LTM) back to the filled residuals to get the final gap-filled LST.
// Clip the results to the Vietnam boundary.
var finalDay = filledResidualsDay.map(function (img) {
    return img.add(meanDay).rename('final_LST_Day_C').clip(viet_nam)
        .set('system:time_start', img.get('system:time_start'));
});
var finalNight = filledResidualsNight.map(function (img) {
    return img.add(meanNight).rename('final_LST_Night_C').clip(viet_nam)
        .set('system:time_start', img.get('system:time_start'));
});

// ----------------------------------------------------------------------------------
// Section 13: Map Display Setup
// ----------------------------------------------------------------------------------

// Center the map on Vietnam.
Map.centerObject(viet_nam, 6);

// Prepare image collections for display on the map for the 'displayStart' to 'displayEnd' period.
var finalDayDisplay = finalDay.filterDate(displayStart, displayEnd);
var finalNightDisplay = finalNight.filterDate(displayStart, displayEnd);

// Prepare raw (quality-filtered and Celsius-converted) data for comparison on the map.
var rawTerraDay = modisTerraFiltered.select('filtered_LST_Day_1km')
    .filterDate(displayStart, displayEnd).map(function (img) {
        return img.multiply(0.02).subtract(273.15).clip(viet_nam).rename('LST_Day_C');
    });
var rawTerraNight = modisTerraFiltered.select('filtered_LST_Night_1km')
    .filterDate(displayStart, displayEnd).map(function (img) {
        return img.multiply(0.02).subtract(273.15).clip(viet_nam).rename('LST_Night_C');
    });
var rawAquaDay = modisAquaFiltered.select('filtered_LST_Day_1km')
    .filterDate(displayStart, displayEnd).map(function (img) {
        return img.multiply(0.02).subtract(273.15).clip(viet_nam).rename('LST_Day_C');
    });
var rawAquaNight = modisAquaFiltered.select('filtered_LST_Night_1km')
    .filterDate(displayStart, displayEnd).map(function (img) {
        return img.multiply(0.02).subtract(273.15).clip(viet_nam).rename('LST_Night_C');
    });

// Define visualization parameters for LST layers.
var lstVisParams = { min: -5, max: 35, palette: ['blue', 'green', 'yellow', 'red'] };

// Add layers to the map.
Map.addLayer(rawTerraDay, lstVisParams, 'Terra Day (Raw °C)');
Map.addLayer(rawTerraNight, lstVisParams, 'Terra Night (Raw °C)');
Map.addLayer(rawAquaDay, lstVisParams, 'Aqua Day (Raw °C)');
Map.addLayer(rawAquaNight, lstVisParams, 'Aqua Night (Raw °C)');
Map.addLayer(finalDayDisplay, lstVisParams, 'Final LST Day (Filled °C)');
Map.addLayer(finalNightDisplay, lstVisParams, 'Final LST Night (Filled °C)');

// ----------------------------------------------------------------------------------
// Section 14: Console Output for Verification
// ----------------------------------------------------------------------------------

// Print final image collections to the console for basic verification.
print('Final Gap-Filled LST Day Collection:', finalDay);
print('Final Gap-Filled LST Night Collection:', finalNight);

// ==================================================================================
// Section 15: CSV Data Export to Google Drive
// ==================================================================================

// --- Helper Variables for Exporting Single-Day Examples (from 'displayStart' date) ---
var finalDayImageRaw = finalDayDisplay.first();     // Single image: Filled Day LST
var finalNightImageRaw = finalNightDisplay.first();   // Single image: Filled Night LST
// var meanDayImageRaw = meanDay; // LTM Day (already a single image)
// var meanNightImageRaw = meanNight; // LTM Night (already a single image)
var rawTerraDayImageForStatsExport = rawTerraDay.first(); // Single image: Raw Terra Day LST for stats
var rawTerraNightImageForStatsExport = rawTerraNight.first(); // Single image: Raw Terra Night LST for stats
var rawAquaDayImageForStatsExport = rawAquaDay.first(); // Single image: Raw Aqua Day LST for stats
var rawAquaNightImageForStatsExport = rawAquaNight.first(); // Single image: Raw Aqua Night LST for stats
var mergedDayImageForStatsExport = dayData.filterDate(displayStart, displayEnd).first().clip(viet_nam); // Single image: Merged Day LST
var mergedNightImageForStatsExport = nightData.filterDate(displayStart, displayEnd).first().clip(viet_nam); // Single image: Merged Night LST

// Reference image for total pixel count within the ROI (Vietnam boundary).
var totalPixelImage = ee.Image(1).clip(viet_nam.geometry());

// --- Helper Function: Extract LST Time Series for a Point ---
function extractTimeSeries(imageCollection, bandName, point, scale) {
    return imageCollection.map(function (image) {
        var value = image.select(bandName).reduceRegion({
            reducer: ee.Reducer.first(),
            geometry: point,
            scale: scale
        }).get(bandName);
        return ee.Feature(null, {
            'system:time_start': image.get('system:time_start'),
            'LST_Value': value
        });
    });
}

// --- Helper Function: Create Feature with LST Statistics ---
// Input: Single image (Celsius), band name, description.
// Output: Feature with mean, min, max, stdDev, count for the band.
function createImageStatsFeature(image, bandName, descriptionForFeature) {
    var stats = image.select(bandName).reduceRegion({
        reducer: ee.Reducer.mean().combine({
            reducer2: ee.Reducer.minMax(),
            sharedInputs: true
        }).combine({
            reducer2: ee.Reducer.stdDev(),
            sharedInputs: true
        }).combine({
            reducer2: ee.Reducer.count(),
            sharedInputs: true
        }),
        geometry: viet_nam.geometry(),
        scale: 1000,
        maxPixels: 1e10
    });
    return ee.Feature(null, stats).set('image_description', descriptionForFeature);
}

// --- Helper Function: Create Feature with Pixel Coverage Statistics ---
// Input: Single image (with original QC-filtered band), band name, totalPixelImage reference, description.
// Output: Feature with valid_pixels count and total_pixels_in_roi count.
function createCoverageStatsFeature(imageToStat, bandNameToStat, totalPixelsImageRef, descriptionForFeature) {
    var validPixelCount = imageToStat.select(bandNameToStat).mask().reduceRegion({
        reducer: ee.Reducer.sum(), // Sum of masked pixels (1 for valid, 0 for masked)
        geometry: viet_nam.geometry(),
        scale: 1000,
        maxPixels: 1e10
    });
    var totalPixelCount = totalPixelsImageRef.reduceRegion({
        reducer: ee.Reducer.sum(), // Sum of pixels in the constant image (all 1s within ROI)
        geometry: viet_nam.geometry(),
        scale: 1000,
        maxPixels: 1e10
    });
    var coverageDict = ee.Dictionary({
        'valid_pixels': validPixelCount.get(bandNameToStat), // Get the count for the specified band
        'total_pixels_in_roi': totalPixelCount.get('constant') // 'constant' is the default band name for ee.Image(1)
    });
    return ee.Feature(null, coverageDict).set('description', descriptionForFeature);
}

// Define a point for time series extraction (example: Hanoi).
var examplePoint = ee.Geometry.Point([105.84117, 21.0245]);

// --- Group 1: LST Time Series Data at Example Point (Hanoi) ---

// Task 1: Time Series - Merged LST Day - Hanoi
var mergedDayTimeSeriesHanoi = extractTimeSeries(dayData, 'LST_Day_C', examplePoint, 1000);
Export.table.toDrive({
    collection: mergedDayTimeSeriesHanoi,
    description: 'TimeSeries_Merged_LST_Day_Hanoi',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'TimeSeries_Merged_LST_Day_Hanoi',
    fileFormat: 'CSV',
    selectors: ['system:time_start', 'LST_Value']
});

// Task 2: Time Series - Merged LST Night - Hanoi
var mergedNightTimeSeriesHanoi = extractTimeSeries(nightData, 'LST_Night_C', examplePoint, 1000);
Export.table.toDrive({
    collection: mergedNightTimeSeriesHanoi,
    description: 'TimeSeries_Merged_LST_Night_Hanoi',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'TimeSeries_Merged_LST_Night_Hanoi',
    fileFormat: 'CSV',
    selectors: ['system:time_start', 'LST_Value']
});

// Task 3: Time Series - Filled LST Day - Hanoi
var finalDayTimeSeriesHanoi = extractTimeSeries(finalDay, 'final_LST_Day_C', examplePoint, 1000);
Export.table.toDrive({
    collection: finalDayTimeSeriesHanoi,
    description: 'TimeSeries_Final_LST_Day_Hanoi',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'TimeSeries_Final_LST_Day_Hanoi',
    fileFormat: 'CSV',
    selectors: ['system:time_start', 'LST_Value']
});

// Task 4: Time Series - Filled LST Night - Hanoi
var finalNightTimeSeriesHanoi = extractTimeSeries(finalNight, 'final_LST_Night_C', examplePoint, 1000);
Export.table.toDrive({
    collection: finalNightTimeSeriesHanoi,
    description: 'TimeSeries_Final_LST_Night_Hanoi',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'TimeSeries_Final_LST_Night_Hanoi',
    fileFormat: 'CSV',
    selectors: ['system:time_start', 'LST_Value']
});

// --- Group 2: LST Descriptive Statistics (for displayStart date) ---

// Task 5: Stats - Raw Terra Day LST
var rawTerraDayStatsFeat = createImageStatsFeature(rawTerraDayImageForStatsExport, 'LST_Day_C', 'Raw_Terra_LST_Day_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([rawTerraDayStatsFeat]),
    description: 'Stats_Raw_Terra_LST_Day_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Terra_LST_Day_Example',
    fileFormat: 'CSV'
});

// Task 6: Stats - Raw Terra Night LST
var rawTerraNightStatsFeat = createImageStatsFeature(rawTerraNightImageForStatsExport, 'LST_Night_C', 'Raw_Terra_LST_Night_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([rawTerraNightStatsFeat]),
    description: 'Stats_Raw_Terra_LST_Night_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Terra_LST_Night_Example',
    fileFormat: 'CSV'
});

// Task 7: Stats - Raw Aqua Day LST
var rawAquaDayStatsFeat = createImageStatsFeature(rawAquaDayImageForStatsExport, 'LST_Day_C', 'Raw_Aqua_LST_Day_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([rawAquaDayStatsFeat]),
    description: 'Stats_Raw_Aqua_LST_Day_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Aqua_LST_Day_Example',
    fileFormat: 'CSV'
});

// Task 8: Stats - Raw Aqua Night LST
var rawAquaNightStatsFeat = createImageStatsFeature(rawAquaNightImageForStatsExport, 'LST_Night_C', 'Raw_Aqua_LST_Night_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([rawAquaNightStatsFeat]),
    description: 'Stats_Raw_Aqua_LST_Night_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Aqua_LST_Night_Example',
    fileFormat: 'CSV'
});

// Task 9: Stats - Merged Day LST
var mergedDayStatsFeat = createImageStatsFeature(mergedDayImageForStatsExport, 'LST_Day_C', 'Merged_LST_Day_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([mergedDayStatsFeat]),
    description: 'Stats_Merged_LST_Day_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Merged_LST_Day_Example',
    fileFormat: 'CSV'
});

// Task 10: Stats - Merged Night LST
var mergedNightStatsFeat = createImageStatsFeature(mergedNightImageForStatsExport, 'LST_Night_C', 'Merged_LST_Night_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([mergedNightStatsFeat]),
    description: 'Stats_Merged_LST_Night_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Merged_LST_Night_Example',
    fileFormat: 'CSV'
});

// Task 11: Stats - Filled Day LST
var finalDayStatsFeat = createImageStatsFeature(finalDayImageRaw, 'final_LST_Day_C', 'Final_LST_Day_Filled_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([finalDayStatsFeat]),
    description: 'Stats_Final_LST_Day_Filled_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Final_LST_Day_Filled_Example',
    fileFormat: 'CSV'
});

// Task 12: Stats - Filled Night LST
var finalNightStatsFeat = createImageStatsFeature(finalNightImageRaw, 'final_LST_Night_C', 'Final_LST_Night_Filled_Example');
Export.table.toDrive({
    collection: ee.FeatureCollection([finalNightStatsFeat]),
    description: 'Stats_Final_LST_Night_Filled_Example',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Final_LST_Night_Filled_Example',
    fileFormat: 'CSV'
});


// --- Group 3: Pixel Coverage Statistics (for displayStart date) ---
// Note: Uses original QC-filtered bands (e.g., 'filtered_LST_Day_1km') for raw/merged data coverage,
// and final LST bands (e.g., 'final_LST_Day_C') for filled data coverage.

// Task 13: Coverage - Raw Terra Day
var rawTerraDayImageForCoverage = modisTerraFiltered.filterDate(displayStart, displayEnd).select('filtered_LST_Day_1km').first();
var coverageTerraDayFeat = createCoverageStatsFeature(rawTerraDayImageForCoverage, 'filtered_LST_Day_1km', totalPixelImage, 'Raw_Terra_Day_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageTerraDayFeat]),
    description: 'Stats_Raw_Terra_Day_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Terra_Day_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 14: Coverage - Raw Terra Night
var rawTerraNightImageForCoverage = modisTerraFiltered.filterDate(displayStart, displayEnd).select('filtered_LST_Night_1km').first();
var coverageTerraNightFeat = createCoverageStatsFeature(rawTerraNightImageForCoverage, 'filtered_LST_Night_1km', totalPixelImage, 'Raw_Terra_Night_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageTerraNightFeat]),
    description: 'Stats_Raw_Terra_Night_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Terra_Night_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 15: Coverage - Raw Aqua Day
var rawAquaDayImageForCoverage = modisAquaFiltered.filterDate(displayStart, displayEnd).select('filtered_LST_Day_1km').first();
var coverageAquaDayFeat = createCoverageStatsFeature(rawAquaDayImageForCoverage, 'filtered_LST_Day_1km', totalPixelImage, 'Raw_Aqua_Day_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageAquaDayFeat]),
    description: 'Stats_Raw_Aqua_Day_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Aqua_Day_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 16: Coverage - Raw Aqua Night
var rawAquaNightImageForCoverage = modisAquaFiltered.filterDate(displayStart, displayEnd).select('filtered_LST_Night_1km').first();
var coverageAquaNightFeat = createCoverageStatsFeature(rawAquaNightImageForCoverage, 'filtered_LST_Night_1km', totalPixelImage, 'Raw_Aqua_Night_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageAquaNightFeat]),
    description: 'Stats_Raw_Aqua_Night_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Raw_Aqua_Night_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 17: Coverage - Merged Day
var mergedDayImageForCoverage = combined.filterDate(displayStart, displayEnd).select('filtered_LST_Day_1km').first();
var coverageMergedDayFeat = createCoverageStatsFeature(mergedDayImageForCoverage, 'filtered_LST_Day_1km', totalPixelImage, 'Merged_Day_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageMergedDayFeat]),
    description: 'Stats_Merged_Day_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Merged_Day_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 18: Coverage - Merged Night
var mergedNightImageForCoverage = combined.filterDate(displayStart, displayEnd).select('filtered_LST_Night_1km').first();
var coverageMergedNightFeat = createCoverageStatsFeature(mergedNightImageForCoverage, 'filtered_LST_Night_1km', totalPixelImage, 'Merged_Night_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageMergedNightFeat]),
    description: 'Stats_Merged_Night_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Merged_Night_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 19: Coverage - Filled Day
// Uses finalDayImageRaw which has the 'final_LST_Day_C' band after filling.
var coverageFilledDayFeat = createCoverageStatsFeature(finalDayImageRaw, 'final_LST_Day_C', totalPixelImage, 'Filled_Day_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageFilledDayFeat]),
    description: 'Stats_Filled_Day_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Filled_Day_Pixel_Coverage',
    fileFormat: 'CSV'
});

// Task 20: Coverage - Filled Night
// Uses finalNightImageRaw which has the 'final_LST_Night_C' band after filling.
var coverageFilledNightFeat = createCoverageStatsFeature(finalNightImageRaw, 'final_LST_Night_C', totalPixelImage, 'Filled_Night_Pixel_Coverage');
Export.table.toDrive({
    collection: ee.FeatureCollection([coverageFilledNightFeat]),
    description: 'Stats_Filled_Night_Pixel_Coverage',
    folder: 'GEE_LST_Exports_CSV',
    fileNamePrefix: 'Stats_Filled_Night_Pixel_Coverage',
    fileFormat: 'CSV'
});

// --- End of CSV Export Section ---
